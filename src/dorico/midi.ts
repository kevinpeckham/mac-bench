/**
 * A MIDI job: a Standard MIDI File in, the MusicXML (or .mxl) Dorico
 * exports from its import out, with what Dorico's MIDI Import Options
 * window showed when it could be read.
 *
 * `File.Open` of a `.mid` makes no project: Dorico shows its MIDI Import
 * Options window and waits (2026-11-08). That window takes one of two
 * shapes to Accessibility, by Dorico's state (`import-window.ts`,
 * FINDINGS), and the job accepts it according to the shape it finds:
 *
 * - "dialog" (no project open): a window titled "MIDI Import Options"
 *   appears, a readable AXDialog. When it is the only dialog or sheet open
 *   and no menu is, the job reads it (`importWindow` in the result),
 *   presses its OK scoped to dialogs (`press --dialogs`), as the Export
 *   MusicXML dialog's OK is pressed, and checks it has gone.
 * - "opaque" (a project window open): no title to find; the window has
 *   shown when Dorico's non-dialog windows number one more than before
 *   `File.Open` and the new one is opaque. With no dialog, sheet or menu
 *   open, the count still one up and no new project, the job brings Dorico
 *   forward and sends Return, once, never retried (OK is the window's
 *   default button).
 *
 * No option is changed in either. The job then waits for the project,
 * exports it as the export job does (`exportProject`) and closes it
 * unsaved. A project that appears without the window showing first, or
 * after it showed and before it was accepted, is never taken: a score ID
 * can't prove it came from this job's file, so the job stops and leaves it
 * open. A Return or OK that certainly wasn't sent (a refusal, a launch that
 * failed) fails at once; only one that may have gone (no answer in time)
 * still waits for the project, for `wrapUp` to close. The same preflight,
 * failsafe and wrap-up as the export job: the failsafe cancels a
 * dialog-shaped import window (its Cancel), but can't see an opaque one,
 * so one left open is named in the error.
 *
 * Remaining risk, accepted: in the opaque shape, Return goes to whichever
 * Dorico window is key, and Accessibility can't say which that is
 * (checking would need a MacBenchAX rebuild). Right after a `.mid` opens,
 * it has been the import window (Kevin, live, 2026-11-08); in a project
 * window with nothing selected, Return does nothing harmful, and the job
 * never saves a project. A floating window opening or closing near
 * `File.Open` could also give a false N+1; no live dump has checked this
 * yet.
 */
import { AxNoAnswer, type AxNode } from "../ax/client.js";
import type { DoricoClient } from "./client.js";
import {
	blocking,
	DEFAULT_EXPORT_TIMEOUTS,
	type ExportDeps,
	type ExportFormat,
	type ExportResult,
	type ExportTimeouts,
	exportProject,
	failed,
	jobFolder,
	openThings,
	preflight,
	wrapUp,
} from "./export.js";
import {
	axCommand,
	IMPORT_WINDOW,
	type ImportWindow,
	readImportWindow,
	type Survey,
	survey,
	windowSummary,
} from "./import-window.js";
import { as, StepError, safeName } from "./steps.js";

export type MidiFile = { name: string; midi: Uint8Array };

export type MidiResult = ExportResult & { importWindow?: ImportWindow };

/** A Standard MIDI File starts with its `MThd` header chunk (14 bytes at least). */
export const isMidi = (b: Uint8Array) =>
	b.length >= 14 && b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;

/** Dorico as `File.Open` found it: its windows and the newest project seen. */
type Before = Survey & { floor: number };

type Shape = "dialog" | "opaque";

/** What the job saw: the window, if read, and the project it made, once known (`wrapUp` closes it). */
type Seen = { window?: ImportWindow; project: number | null };

/** Whether Dorico has announced a project newer than `floor` (kept up to date as statuses arrive). */
const newer = (dorico: DoricoClient, floor: number) => dorico.highestScoreID > floor;

/** The first project newer than `floor`, if one is announced already or within `ms`; null otherwise. */
async function within(dorico: DoricoClient, floor: number, ms: number): Promise<number | null> {
	if (newer(dorico, floor)) return dorico.highestScoreID;
	return dorico
		.waitForStatus(
			(s) => typeof s.activeOpenScoreID === "number" && s.activeOpenScoreID > floor,
			ms,
		)
		.then(
			(s) => s.activeOpenScoreID as number,
			() => null,
		);
}

/** Just before `File.Open` (preflight has seen no dialog, sheet or menu): what to compare with. */
async function before(deps: ExportDeps): Promise<Before> {
	await deps.dorico.status();
	return { floor: deps.dorico.highestScoreID, ...(await survey(deps.ax, 0)) };
}

const LATER = "if a project appears later, close it without saving";
const CANCEL = `a ${IMPORT_WINDOW} window may be open on the Mac: Cancel it there`;

const unasked = () =>
	new StepError(
		"import",
		`a project appeared without the ${IMPORT_WINDOW} window; it may not be this job's: left open, close it on the Mac without saving`,
	);

/** The opaque shape: one non-dialog window more than before, and that one opaque. */
const oneMoreOpaque = (was: Before, now: Survey) =>
	now.standard === was.standard + 1 && now.opaque === was.opaque + 1;

/**
 * Wait, within `openMs`, for the import window, in either shape. A project
 * appearing first stops the job, left open and never recorded: it may not
 * be this job's.
 */
async function waitForImport(deps: ExportDeps, t: ExportTimeouts, was: Before): Promise<Shape> {
	const end = Date.now() + t.openMs;
	for (;;) {
		const now = await survey(deps.ax);
		const shape = now.titled ? "dialog" : oneMoreOpaque(was, now) ? "opaque" : null;
		if (shape) await deps.dorico.status(); // any project announced so far has arrived
		if (newer(deps.dorico, was.floor)) throw unasked();
		if (shape) return shape;
		if (Date.now() >= end)
			throw new StepError(
				"import",
				`Dorico's ${IMPORT_WINDOW} window didn't show within ${t.openMs} ms, and no project came: no window of that title, and Dorico's windows numbered ${was.standard} before File.Open, ${now.standard} now (${await windowSummary(deps.ax)}); in some states that window can't be seen through Accessibility (FINDINGS), so ${CANCEL}; ${LATER}`,
			);
		await Bun.sleep(t.pollMs);
	}
}

/** A project appearing once the window has shown, before it was accepted: never taken. */
async function noNewProject(deps: ExportDeps, floor: number, what: string) {
	await deps.dorico.status(); // any project announced so far has arrived
	if (newer(deps.dorico, floor))
		throw new StepError(
			"import",
			`a project appeared while the ${IMPORT_WINDOW} window waited; won't ${what}; ${CANCEL}`,
		);
}

/**
 * Send `accepting` (Return, or OK), then wait for the project. A refusal
 * or a launch that failed means it wasn't sent: fail at once, recording
 * nothing. No answer in time means it may have gone: still wait for the
 * project and record it, for `wrapUp` to close.
 */
async function send(
	deps: ExportDeps,
	t: ExportTimeouts,
	floor: number,
	seen: Seen,
	what: string,
	accepting: () => Promise<unknown>,
): Promise<void> {
	try {
		await accepting();
	} catch (e) {
		const message = `${what} into the ${IMPORT_WINDOW} window: ${(e as Error).message}`;
		if (!(e instanceof AxNoAnswer)) throw new StepError("import", `${message}; ${CANCEL}`);
		seen.project = await within(deps.dorico, floor, t.openMs);
		throw new StepError(
			"import",
			seen.project === null
				? `${message}; the window may still be open: ${CANCEL}; ${LATER}`
				: message,
		);
	}
}

/** The opaque shape: Return, once, after checking again that it can only go there. */
async function acceptOpaque(
	deps: ExportDeps,
	t: ExportTimeouts,
	was: Before,
	seen: Seen,
): Promise<number> {
	const open = await blocking(deps.ax);
	if (open.windows.length || open.menuOpen !== null)
		throw new StepError(
			"import",
			`won't send Return with these open: ${openThings(open).join(", ")}; ${CANCEL}`,
		);
	const now = await survey(deps.ax, 0);
	await noNewProject(deps, was.floor, "send Return");
	if (!oneMoreOpaque(was, now))
		throw new StepError(
			"import",
			`Dorico's windows numbered ${now.standard} just before Return, not ${was.standard + 1}; won't send Return; ${CANCEL}`,
		);
	await deps.activate();
	await send(deps, t, was.floor, seen, "Return", () =>
		axCommand(deps.ax, "keys", "--combo", "return"),
	);
	seen.project = await within(deps.dorico, was.floor, t.openMs);
	if (seen.project === null)
		throw new StepError(
			"import",
			`Return didn't take or Dorico made no project within ${t.openMs} ms; the ${IMPORT_WINDOW} window may still be open: Cancel it on the Mac; ${LATER}`,
		);
	return seen.project;
}

const isImport = (w: AxNode) => w.AXTitle === IMPORT_WINDOW;

/** The titled window gone from the dialogs, within `dialogMs`. */
async function gone(deps: ExportDeps, t: ExportTimeouts): Promise<boolean> {
	const end = Date.now() + t.dialogMs;
	while ((await blocking(deps.ax)).windows.some(isImport)) {
		if (Date.now() >= end) return false;
		await Bun.sleep(t.pollMs);
	}
	return true;
}

/** The dialog shape: read it, then OK scoped to dialogs, when it is the one thing open. */
async function acceptDialog(
	deps: ExportDeps,
	t: ExportTimeouts,
	was: Before,
	seen: Seen,
): Promise<number> {
	const open = await blocking(deps.ax);
	const only = open.windows[0];
	if (open.windows.length !== 1 || !only || !isImport(only) || open.menuOpen !== null)
		throw new StepError(
			"import",
			`won't press OK with these open: ${openThings(open).join(", ") || "nothing"}`,
		);
	const r = await axCommand(deps.ax, "dump", "--dialogs", "--depth", "12");
	const ws = Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];
	const w = ws.find(isImport);
	if (!w) throw new StepError("import", `Dorico's ${IMPORT_WINDOW} window went away before OK`);
	seen.window = readImportWindow(w);
	await noNewProject(deps, was.floor, "press OK");
	await send(deps, t, was.floor, seen, "OK", () =>
		axCommand(deps.ax, "press", "--dialogs", "--title", "OK", "--role", "AXButton"),
	);
	if (!(await gone(deps, t))) {
		seen.project = await within(deps.dorico, was.floor, 0);
		throw new StepError(
			"import",
			`OK didn't take: Dorico's ${IMPORT_WINDOW} window is still open after ${t.dialogMs} ms`,
		);
	}
	seen.project = await within(deps.dorico, was.floor, t.openMs);
	if (seen.project === null)
		throw new StepError(
			"import",
			`Dorico made no project from the MIDI file within ${t.openMs} ms of OK; ${LATER}`,
		);
	return seen.project;
}

/** One MIDI file through Dorico's import and MusicXML export. Never throws. */
export async function importMidi(
	deps: ExportDeps,
	file: MidiFile,
	format: ExportFormat,
	workDir: string,
	t: ExportTimeouts = DEFAULT_EXPORT_TIMEOUTS,
): Promise<MidiResult> {
	const { name } = file;
	if (!isMidi(file.midi))
		return {
			name,
			ok: false,
			step: "check",
			message: "not a Standard MIDI File (no MThd header)",
		};
	const stop = await preflight(deps);
	if (stop) return { name, ok: false, ...stop };
	const job = jobFolder(workDir, safeName(name, ".mid"), file.midi);
	const seen: Seen = { project: null };
	let result: ExportResult;
	try {
		const was = await as("open", () => before(deps));
		await as("open", () => deps.dorico.command(`File.Open?File=${job.input}`));
		const shape = await as("import", () => waitForImport(deps, t, was));
		const project = await as("import", () =>
			shape === "dialog" ? acceptDialog(deps, t, was, seen) : acceptOpaque(deps, t, was, seen),
		);
		result = { name, ...(await exportProject(deps, t, project, job.out, format)) };
	} catch (e) {
		result = failed(name, e);
	}
	const done = await wrapUp(deps, t, result, seen.project, job.dir);
	return seen.window ? { ...done, importWindow: seen.window } : done;
}
