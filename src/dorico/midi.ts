/**
 * A MIDI job: a Standard MIDI File in, the MusicXML (or .mxl) Dorico
 * exports from its import out, with what Dorico's MIDI Import Options
 * window showed (each track's instrument and destination).
 *
 * `File.Open` of a `.mid` makes no project: Dorico shows its MIDI Import
 * Options window and waits (2026-11-08). The job waits for that window,
 * records it, accepts it with OK (typing nothing into it and changing no
 * option), waits for the project, then exports it as the export job does
 * (`exportProject`) and closes it unsaved. The same preflight, failsafe
 * and wrap-up as the export job; the failsafe cancels the import window.
 */
import type { AxNode } from "../ax/client.js";
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
	DEEP_DUMP_MS,
	type DumpTiming,
	deepDump,
	IMPORT_WINDOW,
	type ImportWindow,
	importWindows,
	isImportWindow,
	pressImportButton,
	readImportWindow,
	windowSummary,
	wontLand,
} from "./import-window.js";
import type { Status } from "./protocol.js";
import { as, StepError, safeName } from "./steps.js";

export type { ImportTrack, ImportWindow } from "./import-window.js";

export type MidiFile = { name: string; midi: Uint8Array };

export type MidiResult = ExportResult & { importWindow?: ImportWindow };

/** A Standard MIDI File starts with its `MThd` header chunk (14 bytes at least). */
export const isMidi = (b: Uint8Array) =>
	b.length >= 14 && b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;

/** Ask Dorico to open `path`. */
async function openMidi(dorico: DoricoClient, path: string): Promise<void> {
	await dorico.status();
	await dorico.command(`File.Open?File=${path}`);
}

/** Wait for the import window. */
async function waitForImport(deps: ExportDeps, t: ExportTimeouts): Promise<void> {
	const end = Date.now() + t.openMs;
	while ((await importWindows(deps.ax)).length === 0) {
		if (Date.now() >= end)
			throw new StepError(
				"import",
				`Dorico's ${IMPORT_WINDOW} window didn't show within ${t.openMs} ms; windows seen: ${await windowSummary(deps.ax)}`,
			);
		await Bun.sleep(t.pollMs);
	}
}

/** What the job saw of the import, and the project it made, once known: `wrapUp` closes it. */
type Import = { window?: ImportWindow; dumps: DumpTiming[]; project: number | null };

/**
 * One deep dump: the import window read into `seen`, and where OK would
 * land checked (the same dump: they are slow with a large project open).
 */
async function readWindow(deps: ExportDeps, seen: Import): Promise<void> {
	const ws = await deepDump(deps.ax, seen.dumps);
	const found = ws.filter(isImportWindow);
	if (found.length !== 1)
		throw new StepError("import", `${found.length} ${IMPORT_WINDOW} windows open, not one`);
	seen.window = readImportWindow(found[0] as AxNode);
	const refused = wontLand(ws, "OK");
	if (refused) throw new StepError("import", refused);
}

/** The import window gone, within `dialogMs`; true, or false if it is still open. */
async function windowGone(deps: ExportDeps, t: ExportTimeouts): Promise<boolean> {
	const end = Date.now() + t.dialogMs;
	while ((await importWindows(deps.ax)).length > 0) {
		if (Date.now() >= end) return false;
		await Bun.sleep(t.pollMs);
	}
	return true;
}

/** `made`'s project, if it comes within `ms`; null otherwise. */
const within = (made: Promise<Status>, ms: number): Promise<number | null> =>
	Promise.race([
		made.then(
			(s) => s.activeOpenScoreID as number,
			() => null,
		),
		Bun.sleep(ms).then(() => null),
	]);

const LATER = "if Dorico makes a project from it later, close it without saving";

/**
 * OK in the import window, when it is the one thing open, then the project
 * Dorico makes from it: the first newer than any seen just before OK (so a
 * project opened meanwhile is never taken for it). Once OK is sent, any
 * failure still waits for that project and records it in `seen.project`,
 * for `wrapUp` to close; if none comes, the error says to close it.
 */
async function accept(deps: ExportDeps, t: ExportTimeouts, seen: Import): Promise<number> {
	const open = await blocking(deps.ax);
	const only = open.windows[0];
	if (open.windows.length !== 1 || !only || !isImportWindow(only) || open.menuOpen !== null)
		throw new StepError(
			"import",
			`won't press OK with these open: ${openThings(open).join(", ") || "nothing"}`,
		);
	await readWindow(deps, seen);
	await deps.dorico.status();
	const floor = deps.dorico.highestScoreID;
	const made = deps.dorico.waitForStatus(
		(s) => typeof s.activeOpenScoreID === "number" && s.activeOpenScoreID > floor,
		t.dialogMs + 2 * t.openMs + DEEP_DUMP_MS,
	);
	made.catch(() => {});
	let stillOpen = false;
	try {
		await pressImportButton(deps.ax, "OK");
		stillOpen = !(await windowGone(deps, t));
		if (stillOpen)
			throw new StepError(
				"import",
				`OK didn't take: Dorico's ${IMPORT_WINDOW} window is still open after ${t.dialogMs} ms; windows seen: ${await windowSummary(deps.ax)}`,
			);
	} catch (e) {
		// OK may have taken all the same (an answer that came too late, a dump Dorico was too busy for).
		seen.project = await within(made, stillOpen ? 0 : t.openMs);
		const err = e instanceof StepError ? e : new StepError("import", (e as Error).message);
		if (seen.project === null && !stillOpen) err.message = `${err.message}; ${LATER}`;
		throw err;
	}
	seen.project = await within(made, t.openMs);
	if (seen.project === null)
		throw new StepError(
			"open",
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
	const seen: Import = { dumps: [], project: null };
	let result: ExportResult;
	try {
		await as("open", () => openMidi(deps.dorico, job.input));
		await as("import", () => waitForImport(deps, t));
		const project = await as("import", () => accept(deps, t, seen));
		result = { name, ...(await exportProject(deps, t, project, job.out, format)) };
	} catch (e) {
		result = failed(name, e);
	}
	const done = await wrapUp(deps, t, result, seen.project, job.dir);
	return seen.window ? { ...done, importWindow: { ...seen.window, dumps: seen.dumps } } : done;
}
