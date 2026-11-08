/**
 * An export job: MusicXML in, the MusicXML (or .mxl) Dorico writes from it
 * out. Remote Control has no export that takes a path (FINDINGS), so the job
 * opens the file through Remote Control as job.ts does, then answers
 * Dorico's own Export MusicXML dialog through MacBenchAX (macOS
 * Accessibility), as the spike of 2026-11-07 did.
 *
 * Each file gets a fresh job folder: `in/` holds the input, `out-<job>/`
 * receives the export. A job starts only if Dorico shows no dialog and no
 * open menu. Whatever happens, a failsafe cancels every dialog left open
 * and closes any open menu, and the project is closed unsaved, by its ID,
 * while it is in front. The only text this file types is the folder path;
 * the only OK it presses is the Export MusicXML dialog's, and it sends
 * Return only to the Go to Folder sheet once that holds the path. The MIDI
 * job (`midi.ts`) shares the export path (`exportProject`) and the wrap-up,
 * and also presses OK in, or sends Return to, Dorico's MIDI Import Options
 * window (its own rules are there). A dialog-shaped import window counts as
 * a dialog here like any other (preflight refuses one, the failsafe cancels
 * one); an opaque one can't be seen (`import-window.ts`) and shows only as
 * a `File.Open` that makes nothing.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type AxClient, type AxNode, isDialog } from "../ax/client.js";
import type { DoricoClient } from "./client.js";
import { axCommand as ax, flat, IMPORT_WINDOW } from "./import-window.js";
import type { JobFile, Timeouts } from "./job.js";
import {
	as,
	close,
	focus,
	inFront,
	isMusicXml,
	jobDir,
	LEFT_OPEN,
	open,
	POLL_MS,
	type Step,
	StepError,
	safeName,
	settled,
} from "./steps.js";

export type ExportFormat = "musicxml" | "mxl";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["musicxml", "mxl"];

export type ExportResult =
	| { name: string; ok: true; file: Uint8Array; exported: string }
	| { name: string; ok: false; step: Step; message: string };

export type ExportTimeouts = Timeouts & {
	/** How long a dialog, sheet or change in one may take to show. */
	dialogMs: number;
	/** The pause between failsafe rounds. */
	settleMs: number;
	pollMs: number;
};

export const DEFAULT_EXPORT_TIMEOUTS: ExportTimeouts = {
	openMs: 30_000,
	exportMs: 60_000,
	closeMs: 15_000,
	dialogMs: 10_000,
	settleMs: 800,
	pollMs: POLL_MS,
};

export type ExportDeps = {
	dorico: DoricoClient;
	ax: AxClient;
	/** Bring Dorico to the front: keystrokes go to the frontmost app. */
	activate: () => Promise<void>;
	/** The home folder, for an "Export to:" shown as `~/…` (default: this user's). */
	home?: string;
};

/** Dorico's titles, as the spike read them (Dorico Elements 6.2.31). */
const MENU = "File/Export/MusicXML...";
const EXPORT = "Export MusicXML";
const MXL = "Export compressed XML (.mxl)";
const XML = "Export uncompressed XML (.musicxml)";
const SEPARATE = "Export layouts as separate files";
const FOLDER = "Create folder for exported files";
const FULL_SCORE = "Full score";
/** The folder button's title: a private-use glyph (its identifier ends `chooseFolderPathPushButton`). */
const FOLDER_BUTTON = "";

/** How to ask for the grant on the Mac (`--out` is required, inside the work folder). */
export const REQUEST_COMMAND =
	'open -a "$HOME/Library/Application Support/mac-bench/ax/MacBenchAX.app" --args request --out "$HOME/Library/Application Support/mac-bench/ax/answers/request.json"';

export const NOT_TRUSTED =
	"MacBenchAX isn't allowed to use Accessibility, so Dorico's export dialog can't be answered: " +
	`on the Mac run ${REQUEST_COMMAND}, then switch MacBenchAX on in System Settings > ` +
	"Privacy & Security > Device Control and Data Access > Accessibility (README)";

/** Dorico's dialogs (and other windows' sheets): never its document windows' trees. */
type Seen = { windows: AxNode[]; menuOpen: string | null };

async function look(client: AxClient, depth = 12): Promise<Seen> {
	const r = await ax(client, "dump", "--dialogs", "--depth", String(depth));
	const all = Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];
	return {
		// MacBenchAX already leaves out other windows; this keeps the rule in one place.
		windows: all.filter((w) => isDialog(w) || w.AXRole === "AXSheet"),
		menuOpen: typeof r.menuOpen === "string" ? r.menuOpen : null,
	};
}

/** What would block a job: the dialogs, sheets and an open menu (`look`, one level down). */
export const blocking = (client: AxClient): Promise<Seen> => look(client, 1);

/**
 * Press an element of Dorico's dialogs. Dorico rebuilds a dialog's
 * accessibility tree after a checkbox changes, and for a moment finds
 * nothing (FINDINGS): a press that finds nothing is tried again, for at
 * most `dialogMs`.
 */
async function press(client: AxClient, t: ExportTimeouts, ...args: string[]) {
	const end = Date.now() + t.dialogMs;
	for (;;) {
		const r = await client.run(["press", "--dialogs", ...args]);
		const missing = typeof r.error === "string" && r.error.startsWith("nothing titled");
		if (!missing || Date.now() >= end) {
			if (typeof r.error === "string") throw new Error(`MacBenchAX press: ${r.error}`);
			if (r.ok === false) throw new Error(`MacBenchAX press ${args.join(" ")} didn't take`);
			return r;
		}
		await Bun.sleep(t.pollMs);
	}
}

const dialog = (ws: AxNode[], title: string) =>
	ws.find((w) => w.AXSubrole === "AXDialog" && w.AXTitle === title);
const titleOf = (w: AxNode) => w.AXTitle || w.AXSubrole || w.AXRole || "untitled";
const noSlash = (p: string) => p.replace(/\/+$/, "");
/** What is open, for a message: the dialogs, and a menu. */
export const openThings = (s: Seen) => [
	...s.windows.map(titleOf),
	...(s.menuOpen !== null ? [`the ${s.menuOpen || "untitled"} menu`] : []),
];

/**
 * Poll the dialogs until `pick` finds something, for at most `dialogMs`;
 * then stop as `step`, saying `failed(last windows)`.
 */
async function waitFor<T>(
	client: AxClient,
	t: ExportTimeouts,
	step: Step,
	pick: (ws: AxNode[]) => T | undefined,
	failed: (ws: AxNode[]) => string,
): Promise<T> {
	const end = Date.now() + t.dialogMs;
	for (;;) {
		const { windows } = await look(client);
		const found = pick(windows);
		if (found !== undefined) return found;
		if (Date.now() >= end) throw new StepError(step, failed(windows));
		await Bun.sleep(t.pollMs);
	}
}

const exportDialog = (client: AxClient, t: ExportTimeouts, step: Step) =>
	waitFor(
		client,
		t,
		step,
		(ws) => dialog(ws, EXPORT),
		() => `Dorico's ${EXPORT} dialog didn't show within ${t.dialogMs} ms`,
	);

/** File > Export > MusicXML..., into a Dorico showing no dialog; once more if a menu was left open. */
async function openExport(deps: ExportDeps, t: ExportTimeouts) {
	const before = await blocking(deps.ax);
	if (before.windows.length || before.menuOpen !== null)
		throw new StepError(
			"dialog",
			`Dorico isn't clear before the menu: ${openThings(before).join(", ")}`,
		);
	for (let attempt = 1; ; attempt++) {
		await deps.activate();
		await ax(deps.ax, "menu", "--path", MENU);
		try {
			return await exportDialog(deps.ax, t, "dialog");
		} catch (e) {
			if (attempt > 1) throw e;
			const now = await blocking(deps.ax);
			if (now.windows.length) throw e; // something else showed: the failsafe's business
			if (now.menuOpen !== null) {
				await deps.activate();
				await ax(deps.ax, "keys", "--combo", "escape");
			}
		}
	}
}

/** The dialog's checkboxes, in order, from just after the one titled `after` if given. */
const boxes = (d: AxNode, after?: string) => {
	const all = flat(d).filter((n) => n.AXRole === "AXCheckBox");
	return after === undefined ? all : all.slice(all.findIndex((b) => b.AXTitle === after) + 1);
};
const value = (d: AxNode, title: string, after?: string) => {
	const box = boxes(d, after).find((b) => b.AXTitle === title);
	if (!box) throw new StepError("options", `no "${title}" checkbox in Dorico's ${EXPORT} dialog`);
	return Number(box.AXValue);
};

/** Make the dialog's checkboxes as `format` needs, pressing only those that differ. */
async function options(client: AxClient, t: ExportTimeouts, format: ExportFormat) {
	// The wanted format on before the other goes off: Dorico may insist on one.
	// Full score is the layout (after "separate files"), never a flow of that name.
	const wanted: [string, number, string?][] = [
		[format === "mxl" ? MXL : XML, 1],
		[format === "mxl" ? XML : MXL, 0],
		[FOLDER, 0],
		[SEPARATE, 0],
		[FULL_SCORE, 1, SEPARATE],
	];
	let d = await exportDialog(client, t, "options");
	for (const [title, want, after] of wanted) {
		if (value(d, title, after) === want) continue;
		await press(
			client,
			t,
			"--title",
			title,
			"--role",
			"AXCheckBox",
			...(after ? ["--after", after] : []),
		);
		d = await exportDialog(client, t, "options");
	}
	for (const [title, want, after] of wanted) {
		const v = value(d, title, after);
		if (v !== want)
			throw new StepError("options", `"${title}" is ${v} after pressing it, not ${want}`);
	}
	// Flows (listed between the format boxes and the layouts) stay as Dorico has them.
	const all = boxes(d).map((b) => b.AXTitle);
	const flows = boxes(d).slice(
		Math.max(all.indexOf(MXL), all.indexOf(XML)) + 1,
		all.indexOf(SEPARATE),
	);
	if (!flows.some((f) => Number(f.AXValue) === 1))
		throw new StepError("options", "no flow is selected for export in Dorico's dialog");
}

/** `~/…` as a full path. */
const expand = (p: string, home: string) =>
	p === "~" || p.startsWith("~/") ? home + p.slice(1) : p;

/** Point the dialog's "Export to:" at `out` through the Open panel. */
async function folder(deps: ExportDeps, t: ExportTimeouts, out: string) {
	const client = deps.ax;
	// MacBenchAX posts keys only while Dorico is frontmost: bring it forward before each.
	const keys = async (combo: string) => {
		await deps.activate();
		await ax(client, "keys", "--combo", combo);
	};
	await press(client, t, "--title", FOLDER_BUTTON, "--role", "AXButton");
	const panel = (ws: AxNode[]) => dialog(ws, "Open");
	await waitFor(client, t, "folder", panel, () => "the folder picker (Open) didn't show");
	const field = (ws: AxNode[]) => {
		const p = panel(ws);
		const s = p && flat(p).find((n) => n.AXRole === "AXSheet");
		return s && flat(s).find((n) => n.AXRole === "AXTextField");
	};
	const where = (ws: AxNode[]) => {
		const p = panel(ws);
		return p && flat(p).find((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === "Where:");
	};
	// Return can still leave the panel where it was: the whole Go to Folder step once more.
	for (let attempt = 1; ; attempt++) {
		// The panel can show before it takes keys, and the first ⌘⇧G is lost (FINDINGS): once more.
		for (let tries = 1; ; tries++) {
			await keys("cmd+shift+g");
			try {
				await waitFor(client, t, "folder", field, () => "the Go to Folder sheet didn't show");
				break;
			} catch (e) {
				if (tries > 1) throw e;
			}
		}
		await ax(client, "set", "--dialogs", "--sheet", "--value", `${out}/`);
		// Return only into the sheet, holding the path: without it, Return would be
		// the Open panel's Choose (Dorico's remembered folder) or the dialog's OK.
		await waitFor(
			client,
			t,
			"folder",
			(ws) => (field(ws)?.AXValue === `${out}/` ? true : undefined),
			(ws) =>
				field(ws)
					? `the Go to Folder sheet holds "${String(field(ws)?.AXValue ?? "")}", not the job's folder`
					: "the Go to Folder sheet went away before Return",
		);
		// Return straight after the path is set can close the sheet without going there (FINDINGS).
		await Bun.sleep(t.settleMs);
		await keys("return");
		try {
			await waitFor(
				client,
				t,
				"folder",
				(ws) => (!field(ws) && where(ws)?.AXValue === basename(out) ? true : undefined),
				(ws) =>
					`the folder picker didn't go to the job's folder (Where: shows "${String(where(ws)?.AXValue ?? "nothing")}")`,
			);
			break;
		} catch (e) {
			if (attempt > 1) throw e;
		}
	}
	await press(client, t, "--title", "Choose", "--role", "AXButton");
	const label = (ws: AxNode[]) => {
		const d = dialog(ws, EXPORT);
		const l = d && flat(d).find((n) => n.AXIdentifier?.endsWith("folderPathLabel"));
		return l ? String(l.AXValue ?? "") : undefined;
	};
	const home = deps.home ?? homedir();
	await waitFor(
		client,
		t,
		"folder",
		(ws) => {
			const l = label(ws);
			return !panel(ws) && l !== undefined && noSlash(expand(l, home)) === out ? true : undefined;
		},
		(ws) => `Export to: shows "${label(ws) ?? "nothing"}", not the job's folder ${out}`,
	);
}

/** The exported file in `out` (or a folder in it): the one, or the Full score one of several. */
function pick(out: string, ext: string): string | null {
	const files = (readdirSync(out, { recursive: true }) as string[]).filter((f) => f.endsWith(ext));
	const file = files.length === 1 ? files[0] : files.find((f) => basename(f).includes(FULL_SCORE));
	return file ? join(out, file) : null;
}

async function exportTo(deps: ExportDeps, t: ExportTimeouts, id: number, out: string, ext: string) {
	const open = (await blocking(deps.ax)).windows;
	if (open.length !== 1 || open[0]?.AXTitle !== EXPORT)
		throw new StepError(
			"export",
			`won't press OK with these open: ${open.map(titleOf).join(", ") || "nothing"}`,
		);
	await press(deps.ax, t, "--title", "OK", "--role", "AXButton");
	const got = await settled(() => pick(out, ext), t.exportMs, `${ext} file`, t.pollMs);
	if (!(await inFront(deps.dorico, id)))
		throw new StepError("export", "focus moved to another project while exporting");
	return got;
}

/** Escape into Dorico (brought forward first: MacBenchAX types only into it). */
async function pressEscape(deps: ExportDeps, t: ExportTimeouts) {
	await deps.activate().catch(() => {});
	await ax(deps.ax, "keys", "--combo", "escape").catch(() => {});
	await Bun.sleep(t.settleMs);
}

/**
 * Cancel every dialog Dorico has open and close an open menu: up to four
 * rounds of `dismiss` (Escape first for a menu), from the second with
 * Escape too, which closes what has no Cancel (the Go to Folder sheet).
 * Returns what is still open, as an error, or null. A MIDI Import Options
 * window can't be seen, so it is never cancelled here.
 */
async function failsafe(deps: ExportDeps, t: ExportTimeouts): Promise<string | null> {
	try {
		for (let round = 0; round < 4; round++) {
			const now = await blocking(deps.ax);
			if (now.menuOpen !== null) await pressEscape(deps, t);
			if (now.windows.length === 0) {
				if (now.menuOpen === null) return null;
				continue;
			}
			await ax(deps.ax, "dismiss").catch(() => {});
			await Bun.sleep(t.settleMs);
			if (round > 0 && (await blocking(deps.ax)).windows.length > 0) await pressEscape(deps, t);
		}
		const left = await blocking(deps.ax);
		const things = openThings(left);
		return things.length
			? `a Dorico dialog is still open: ${things.join(", ")}; dismiss it by screen sharing`
			: null;
	} catch (e) {
		return `couldn't check Dorico for open dialogs (${(e as Error).message}); look by screen sharing`;
	}
}

/** Fail `r` with `message` (added to an earlier failure's), keeping the first failing step. */
const fail = (r: ExportResult, step: Step, message: string): ExportResult =>
	r.ok
		? { name: r.name, ok: false, step, message }
		: { ...r, message: r.message.includes(message) ? r.message : `${r.message}; ${message}` };

/** Before anything: MacBenchAX trusted, and Dorico showing no dialog, sheet or menu. */
export async function preflight(deps: ExportDeps): Promise<{ step: Step; message: string } | null> {
	try {
		if ((await deps.ax.run(["trusted"])).trusted !== true)
			return { step: "ax", message: NOT_TRUSTED };
	} catch (e) {
		return { step: "ax", message: (e as Error).message };
	}
	try {
		const now = await blocking(deps.ax);
		const things = openThings(now);
		// Not cancelled: it may be someone's. A job's own is cancelled by its failsafe.
		if (things.length)
			return {
				step: "preflight",
				message: `a dialog is already open in Dorico: ${things.join(", ")}; close it (by screen sharing) and try again`,
			};
	} catch (e) {
		return { step: "ax", message: (e as Error).message };
	}
	return null;
}

/** Why a `File.Open` may make nothing though Dorico showed no dialog. */
const UNSEEN = `a window Accessibility can't see (such as a ${IMPORT_WINDOW} window) may be in the way: look by screen sharing`;

/** One file through Dorico's MusicXML export. Never throws: a failure names the step that stopped. */
export async function exportFile(
	deps: ExportDeps,
	file: JobFile,
	format: ExportFormat,
	workDir: string,
	t: ExportTimeouts = DEFAULT_EXPORT_TIMEOUTS,
): Promise<ExportResult> {
	const { name } = file;
	if (!isMusicXml(file.xml))
		return {
			name,
			ok: false,
			step: "check",
			message: "not MusicXML (no <score-partwise> or <score-timewise>)",
		};
	const stop = await preflight(deps);
	if (stop) return { name, ok: false, ...stop };
	const job = jobFolder(workDir, safeName(name), file.xml);
	let id: number | null = null;
	let result: ExportResult;
	try {
		const project = await as("open", () => open(deps.dorico, job.input, t.openMs)).catch(
			(e: StepError) => {
				if (e.step === "open") e.message = `${e.message}; ${UNSEEN}`;
				throw e;
			},
		);
		id = project;
		result = { name, ...(await exportProject(deps, t, project, job.out, format)) };
	} catch (e) {
		result = failed(name, e);
	}
	return wrapUp(deps, t, result, id, job.dir);
}

/** A fresh job folder: `in/<file>` holding `data`, and `out-<job>/` for the export. */
export function jobFolder(workDir: string, file: string, data: string | Uint8Array) {
	const dir = jobDir(workDir);
	// A leaf unique to the job: "Where:" naming it can't be an earlier job's folder.
	const out = join(dir, `out-${basename(dir)}`);
	mkdirSync(join(dir, "in"));
	mkdirSync(out);
	const input = join(dir, "in", file);
	writeFileSync(input, data);
	return { dir, out, input };
}

/** A failure as a result, naming its step. */
export const failed = (name: string, e: unknown): ExportResult => {
	const err = e instanceof StepError ? e : new StepError("open", String(e));
	return { name, ok: false, step: err.step, message: err.message };
};

/** The project in front exported through Dorico's Export MusicXML dialog into `out`. */
export async function exportProject(
	deps: ExportDeps,
	t: ExportTimeouts,
	project: number,
	out: string,
	format: ExportFormat,
): Promise<{ ok: true; file: Uint8Array; exported: string }> {
	const ext = format === "mxl" ? ".mxl" : ".musicxml";
	await as("focus", () => focus(deps.dorico, project));
	await as("dialog", () => openExport(deps, t));
	await as("options", () => options(deps.ax, t, format));
	await as("folder", () => folder(deps, t, out));
	const got = await as("export", () => exportTo(deps, t, project, out, ext));
	return { ok: true, file: got.bytes, exported: basename(got.path) };
}

/**
 * Whatever happened: the failsafe, then the job's project (`id`, if one was
 * made) closed unsaved, unless a dialog stayed open; the job folder goes
 * after a success and is kept after a failure.
 */
export async function wrapUp(
	deps: ExportDeps,
	t: ExportTimeouts,
	before: ExportResult,
	id: number | null,
	dir: string,
): Promise<ExportResult> {
	let result = before;
	const left = await failsafe(deps, t);
	if (left) result = fail(result, "failsafe", left);
	if (id !== null) {
		const project = id;
		if (left) result = fail(result, "failsafe", LEFT_OPEN);
		else
			try {
				await as("close", () => close(deps.dorico, project, t.closeMs));
			} catch (e) {
				result = fail(result, "close", (e as Error).message);
			}
	}
	if (result.ok) {
		await Bun.sleep(t.settleMs); // a straggling second file from Dorico lands before the folder goes
		rmSync(dir, { recursive: true, force: true });
	}
	return result;
}
