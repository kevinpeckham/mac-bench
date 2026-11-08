/**
 * Dorico's MIDI Import Options window (Elements 6.2.31, 2026-11-08):
 * `File.Open` of a `.mid` answers `kOK`, makes no project and shows it; the
 * project is made only once it is accepted. How it looks to Accessibility
 * depends on Dorico's state (FINDINGS):
 *
 * - "dialog": with no project open (the Steinberg Hub only), it is an
 *   AXWindow/AXDialog titled "MIDI Import Options", readable like any
 *   dialog (`readImportWindow`), and the Hub an AXWindow/AXStandardWindow.
 * - "opaque": with a project window open, Dorico's standard windows (that
 *   one and the import window) describe themselves as the application
 *   (AXRole "AXApplication", AXTitle "Dorico", no subrole), with the app's
 *   own windows and menu bar again as children: a self-similar tree with
 *   no title and no contents. It can only be counted (`survey`).
 */
import { type AxClient, type AxNode, isDialog } from "../ax/client.js";

/** The window's title, as Dorico shows it on screen: for messages only. */
export const IMPORT_WINDOW = "MIDI Import Options";

/** Run a MacBenchAX command; an `error` in its answer, or `ok: false`, throws. */
export async function axCommand(
	client: AxClient,
	...args: string[]
): Promise<Record<string, unknown>> {
	const r = await client.run(args);
	if (typeof r.error === "string") throw new Error(`MacBenchAX ${args[0]}: ${r.error}`);
	if (r.ok === false) throw new Error(`MacBenchAX ${args.join(" ")} didn't take`);
	return r;
}

/**
 * All of Dorico's windows, documents included, `depth` levels down. Keep
 * `depth` small: each standard window lists every window again under it,
 * so a dump grows as the number of windows to the power of its depth.
 */
const allWindows = async (client: AxClient, depth: number) => {
	const r = await axCommand(client, "dump", "--depth", String(depth));
	return Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];
};

/** A window that isn't a dialog or a sheet: a project window, the import window, a palette. */
const isStandard = (w: AxNode) => !isDialog(w) && w.AXRole !== "AXSheet";

/** What a look at Dorico's windows found: for comparing before and after `File.Open`. */
export type Survey = {
	/** Windows that are neither dialogs nor sheets. */
	standard: number;
	/** Of those, the ones opaque to Accessibility (describing themselves as the application). */
	opaque: number;
	/** A window titled as the import window, whatever its role. */
	titled: AxNode | undefined;
};

const isOpaque = (w: AxNode) => w.AXRole === "AXApplication";

/**
 * Dorico's windows, at most one level down (each opaque window lists every
 * window again under it): how many are standard, how many opaque, and the
 * one titled as the import window, if any.
 */
export async function survey(client: AxClient, depth: 0 | 1 = 1): Promise<Survey> {
	const ws = await allWindows(client, depth);
	const standard = ws.filter(isStandard);
	return {
		standard: standard.length,
		opaque: standard.filter(isOpaque).length,
		titled: ws.find((w) => w.AXTitle === IMPORT_WINDOW),
	};
}

const label = (n: AxNode) =>
	isOpaque(n)
		? "window (opaque to Accessibility)"
		: `${n.AXRole ?? "?"}${n.AXSubrole ? `/${n.AXSubrole}` : ""}${n.AXTitle ? ` "${n.AXTitle}"` : ""}`;

/**
 * Dorico's windows, their roles and titles and a dialog's children's, for
 * an error message: one level down, an opaque window by its label alone.
 */
export async function windowSummary(client: AxClient): Promise<string> {
	try {
		const ws = await allWindows(client, 1);
		if (ws.length === 0) return "no windows";
		return ws
			.map((w) => {
				const kids = isOpaque(w) ? [] : (w.children ?? []);
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

/** What the window showed, in the dialog shape, before OK: recorded, never changed. */
export type ImportWindow = {
	file: string | null;
	useTrackMemory: boolean | null;
	interpretAsGeneralMidi: boolean | null;
	columns: string[];
	tracks: ImportTrack[];
};

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
