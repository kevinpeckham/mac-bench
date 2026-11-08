/**
 * Dorico's MIDI Import Options window (Elements 6.2.31, seen live
 * 2026-11-08): `File.Open` of a `.mid` answers `kOK`, makes no project and
 * shows it; the project is made only when its OK is pressed. It is a
 * standard window (traffic-light buttons), not an AXDialog, so MacBenchAX's
 * `--dialogs` never sees it (FINDINGS): it is found by title in a full
 * dump, read, and pressed with an unscoped `press --after` its title, but
 * only once a full dump shows where that press will land.
 */
import { type AxClient, type AxNode, isDialog } from "../ax/client.js";

export const IMPORT_WINDOW = "MIDI Import Options";

/** How deep MacBenchAX's press looks into a window (ax/main.swift, walk). */
const WALK_DEPTH = 14;

/** The children MacBenchAX's dump lists of a node, at most (ax/main.swift, describe); its press walks them all. */
const DUMP_CHILDREN = 200;

/**
 * How long a full dump as deep as a press looks may take to answer: it
 * describes every window Dorico has open, a large document's included,
 * where the client's usual limit is 10 s.
 */
export const DEEP_DUMP_MS = 60_000;

/** A deep dump, timed: the first live runs measure how long they take. */
export type DumpTiming = { depth: number; ms: number };

/** A row of the window's tracks table: its cells' text, and named fields when the columns line up. */
export type ImportTrack = {
	enabled: boolean | null;
	cells: string[];
	name?: string;
	instrument?: string;
	technique?: string;
	family?: string;
	destination?: string;
	maxNotes?: number | null;
	notes?: number | null;
};

/** What the window showed, before OK: recorded, never changed. */
export type ImportWindow = {
	file: string | null;
	useTrackMemory: boolean | null;
	interpretAsGeneralMidi: boolean | null;
	columns: string[];
	tracks: ImportTrack[];
	/** The job's deep dumps (reading the window, checking where OK lands), timed. */
	dumps?: DumpTiming[];
};

/** Run a MacBenchAX command; an `error` in its answer, or `ok: false`, throws. */
export async function axCommand(
	client: AxClient,
	...args: string[]
): Promise<Record<string, unknown>> {
	return answered(args, await client.run(args));
}

function answered(args: string[], r: Record<string, unknown>): Record<string, unknown> {
	if (typeof r.error === "string") throw new Error(`MacBenchAX ${args[0]}: ${r.error}`);
	if (r.ok === false) throw new Error(`MacBenchAX ${args.join(" ")} didn't take`);
	return r;
}

const windowsOf = (r: Record<string, unknown>) =>
	Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];

/** All of Dorico's windows, documents included, `depth` levels down. */
const allWindows = async (client: AxClient, depth: number) =>
	windowsOf(await axCommand(client, "dump", "--depth", String(depth)));

/**
 * All of Dorico's windows as deep as a press looks, given `DEEP_DUMP_MS`
 * to answer; its time is added to `timings`.
 */
export async function deepDump(client: AxClient, timings?: DumpTiming[]): Promise<AxNode[]> {
	const args = ["dump", "--depth", String(WALK_DEPTH)];
	const started = Date.now();
	const r = answered(args, await client.run(args, { timeoutMs: DEEP_DUMP_MS }));
	timings?.push({ depth: WALK_DEPTH, ms: Date.now() - started });
	return windowsOf(r);
}

export const isImportWindow = (w: AxNode) => w.AXTitle === IMPORT_WINDOW && !isDialog(w);

/** The import windows Dorico shows (a full dump, one level down: titles only). */
export const importWindows = async (client: AxClient) =>
	(await allWindows(client, 1)).filter(isImportWindow);

const label = (n: AxNode) =>
	`${n.AXRole ?? "?"}${n.AXSubrole ? `/${n.AXSubrole}` : ""}${n.AXTitle ? ` "${n.AXTitle}"` : ""}`;

/** Dorico's windows, their roles and titles and their children's, for an error message. */
export async function windowSummary(client: AxClient): Promise<string> {
	try {
		const ws = await allWindows(client, 2);
		if (ws.length === 0) return "no windows";
		return ws
			.map((w) => {
				const kids = w.children ?? [];
				const shown = kids.slice(0, 8).map(label);
				if (kids.length > shown.length) shown.push(`… ${kids.length - shown.length} more`);
				return shown.length ? `${label(w)} [${shown.join(", ")}]` : label(w);
			})
			.join("; ");
	} catch (e) {
		return `couldn't list Dorico's windows (${(e as Error).message})`;
	}
}

/** `n` and everything under it, in the order the dump lists them. */
export const flat = (n: AxNode, acc: AxNode[] = []): AxNode[] => {
	acc.push(n);
	for (const c of n.children ?? []) flat(c, acc);
	return acc;
};

/** Seen on the way to a landing: a level the dump may have cut short (its press walks it whole). */
type Walked = { capped: boolean };

/** The first node under `n`, preorder and at most `depth` levels down, that `match` accepts. */
function walk(
	n: AxNode,
	depth: number,
	match: (n: AxNode) => boolean,
	walked: Walked,
): AxNode | null {
	if (match(n)) return n;
	if (depth <= 0) return null;
	const kids = n.children ?? [];
	if (kids.length >= DUMP_CHILDREN) walked.capped = true;
	for (const c of kids) {
		const hit = walk(c, depth - 1, match, walked);
		if (hit) return hit;
	}
	return null;
}

/**
 * The window MacBenchAX's `press --title T --role R --after A` (unscoped)
 * would press in, as main.swift walks: windows in order, `seen` from the
 * first element titled or valued A on, then the first titled T with role R.
 * Null when there is none, or when a level before it held as many children
 * as the dump lists: the press walks them all, and may land in one the dump
 * left out.
 */
export function landing(ws: AxNode[], title: string, role: string, after: string): AxNode | null {
	let seen = false;
	const walked: Walked = { capped: false };
	for (const w of ws) {
		const hit = walk(
			w,
			WALK_DEPTH,
			(n) => {
				if (!seen) {
					if (n.AXTitle === after || n.AXValue === after) seen = true;
					return false;
				}
				return n.AXTitle === title && n.AXRole === role;
			},
			walked,
		);
		if (hit) return walked.capped ? null : w;
		if (walked.capped) return null;
	}
	return null;
}

/** Why a press of `title` in the import window must not be sent, given a deep dump `ws`; null if it lands there. */
export function wontLand(ws: AxNode[], title: string): string | null {
	const w = landing(ws, title, "AXButton", IMPORT_WINDOW);
	return w && isImportWindow(w)
		? null
		: `won't press ${title}: MacBenchAX's press wouldn't land in Dorico's ${IMPORT_WINDOW} window`;
}

/**
 * Press the button titled `title` in the import window, once a deep dump
 * `ws` has shown it lands there (`wontLand`): the window isn't a dialog, so
 * the press can't be scoped with `--dialogs`.
 */
export async function pressImportButton(client: AxClient, title: string): Promise<void> {
	await axCommand(
		client,
		"press",
		"--title",
		title,
		"--role",
		"AXButton",
		"--after",
		IMPORT_WINDOW,
	);
}

/**
 * Press the button titled `title` in the import window, after a deep dump
 * shows where the press will land: anywhere but the import window (a
 * document window's button) is refused.
 */
export async function pressInImport(client: AxClient, title: string): Promise<void> {
	const refused = wontLand(await deepDump(client), title);
	if (refused) throw new Error(refused);
	await pressImportButton(client, title);
}

/** A cell's text: its own or its first descendant's title or value (a checkbox's isn't text). */
function text(n: AxNode): string {
	for (const e of flat(n)) {
		if (e.AXRole === "AXCheckBox") continue;
		if (typeof e.AXValue === "string" && e.AXValue) return e.AXValue;
		if (typeof e.AXValue === "number") return String(e.AXValue);
		if (e.AXTitle) return e.AXTitle;
	}
	return "";
}

const checked = (n: AxNode | undefined) => (n ? Number(n.AXValue) === 1 : null);
const count = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

const FILE_LABEL = "Importing MIDI File:";

/** The columns the window names, by the field each fills. */
const FIELDS = {
	name: "MIDI track name",
	instrument: "Instrument(s) in track",
	technique: "Technique(s)",
	family: "Family",
	destination: "Destination instrument",
} as const;

function track(row: AxNode, columns: string[]): ImportTrack {
	const cells = (row.children ?? []).map(text);
	const t: ImportTrack = {
		enabled: checked(flat(row).find((n) => n.AXRole === "AXCheckBox")),
		cells,
	};
	// Named only when the header and the row line up; otherwise the cells say it all.
	if (columns.length !== cells.length) return t;
	const at = (title: string) => {
		const i = columns.indexOf(title);
		return i >= 0 ? cells[i] : undefined;
	};
	for (const [field, title] of Object.entries(FIELDS) as [keyof typeof FIELDS, string][]) {
		const v = at(title);
		if (v !== undefined) t[field] = v;
	}
	if (columns.includes("Max. sim. notes")) t.maxNotes = count(at("Max. sim. notes"));
	if (columns.includes("Total no. of notes")) t.notes = count(at("Total no. of notes"));
	return t;
}

/** What the import window `w` shows: the file, its two checkboxes, and each track. */
export function readImportWindow(w: AxNode): ImportWindow {
	const all = flat(w);
	const box = (title: string) =>
		checked(all.find((n) => n.AXRole === "AXCheckBox" && n.AXTitle === title));
	// The file's name: after "Importing MIDI File:", in the same text or the next.
	const own = (n: AxNode) => (typeof n.AXValue === "string" ? n.AXValue : (n.AXTitle ?? ""));
	const at = all.findIndex((n) => own(n).startsWith(FILE_LABEL));
	const inline =
		at >= 0
			? own(all[at] as AxNode)
					.slice(FILE_LABEL.length)
					.trim()
			: "";
	const next = at >= 0 ? all.slice(at + 1).find((n) => own(n)) : undefined;
	const table = all.find((n) => n.AXRole === "AXTable" || n.AXRole === "AXOutline");
	const header = (table?.children ?? []).filter((c) => c.AXRole !== "AXRow");
	const columns = header
		.flatMap((h) => flat(h))
		.filter((n) => ["AXButton", "AXStaticText", "AXColumn", "AXCell"].includes(n.AXRole ?? ""))
		.filter((n) => !(n.children ?? []).length)
		.map((n) => n.AXTitle ?? (typeof n.AXValue === "string" ? n.AXValue : ""));
	const rows = (table ? flat(table) : all).filter((n) => n.AXRole === "AXRow");
	return {
		file: inline || (next ? own(next) : null),
		useTrackMemory: box("Use track memory"),
		interpretAsGeneralMidi: box("Interpret as General MIDI"),
		columns,
		tracks: rows.map((r) => track(r, columns)),
	};
}
