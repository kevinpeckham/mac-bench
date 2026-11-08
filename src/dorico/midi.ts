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
	axCommand,
	IMPORT_WINDOW,
	type ImportWindow,
	importWindows,
	isImportWindow,
	pressInImport,
	readImportWindow,
	windowSummary,
} from "./import-window.js";
import { as, StepError, safeName } from "./steps.js";

export type { ImportTrack, ImportWindow } from "./import-window.js";

export type MidiFile = { name: string; midi: Uint8Array };

export type MidiResult = ExportResult & { importWindow?: ImportWindow };

/** A Standard MIDI File starts with its `MThd` header chunk (14 bytes at least). */
export const isMidi = (b: Uint8Array) =>
	b.length >= 14 && b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;

/** How deep the import window is read (as deep as a press looks). */
const READ_DEPTH = 14;

/** Ask Dorico to open `path`; the highest project ID seen before, for spotting the new one. */
async function openMidi(dorico: DoricoClient, path: string): Promise<number> {
	await dorico.status();
	const floor = dorico.highestScoreID;
	await dorico.command(`File.Open?File=${path}`);
	return floor;
}

/** Wait for the import window, then read it. */
async function waitForImport(deps: ExportDeps, t: ExportTimeouts): Promise<ImportWindow> {
	const end = Date.now() + t.openMs;
	while ((await importWindows(deps.ax)).length === 0) {
		if (Date.now() >= end)
			throw new StepError(
				"import",
				`Dorico's ${IMPORT_WINDOW} window didn't show within ${t.openMs} ms; windows seen: ${await windowSummary(deps.ax)}`,
			);
		await Bun.sleep(t.pollMs);
	}
	const r = await axCommand(deps.ax, "dump", "--depth", String(READ_DEPTH));
	const found = (Array.isArray(r.windows) ? (r.windows as AxNode[]) : []).filter(isImportWindow);
	if (found.length !== 1)
		throw new StepError("import", `${found.length} ${IMPORT_WINDOW} windows open, not one`);
	return readImportWindow(found[0] as AxNode);
}

/**
 * OK in the import window, when it is the one thing open, then the project
 * Dorico makes from it: the first newer than `floor`.
 */
async function accept(deps: ExportDeps, t: ExportTimeouts, floor: number): Promise<number> {
	const open = await blocking(deps.ax);
	const only = open.windows[0];
	if (open.windows.length !== 1 || !only || !isImportWindow(only) || open.menuOpen !== null)
		throw new StepError(
			"import",
			`won't press OK with these open: ${openThings(open).join(", ") || "nothing"}`,
		);
	const made = deps.dorico.waitForStatus(
		(s) => typeof s.activeOpenScoreID === "number" && s.activeOpenScoreID > floor,
		t.openMs,
	);
	made.catch(() => {}); // the press may fail first
	await pressInImport(deps.ax, "OK");
	const end = Date.now() + t.dialogMs;
	while ((await importWindows(deps.ax)).length > 0) {
		if (Date.now() >= end)
			throw new StepError(
				"import",
				`OK didn't take: Dorico's ${IMPORT_WINDOW} window is still open after ${t.dialogMs} ms; windows seen: ${await windowSummary(deps.ax)}`,
			);
		await Bun.sleep(t.pollMs);
	}
	const s = await made.catch(() => {
		throw new StepError(
			"open",
			`Dorico made no project from the MIDI file within ${t.openMs} ms of OK; if one opens later, close it without saving`,
		);
	});
	return s.activeOpenScoreID as number;
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
	let id: number | null = null;
	let importWindow: ImportWindow | undefined;
	let result: ExportResult;
	try {
		const floor = await as("open", () => openMidi(deps.dorico, job.input));
		importWindow = await as("import", () => waitForImport(deps, t));
		const project = await as("import", () => accept(deps, t, floor));
		id = project;
		result = { name, ...(await exportProject(deps, t, project, job.out, format)) };
	} catch (e) {
		result = failed(name, e);
	}
	const done = await wrapUp(deps, t, result, id, job.dir);
	return importWindow ? { ...done, importWindow } : done;
}
