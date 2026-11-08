/**
 * A MIDI job: a Standard MIDI File in, the MusicXML (or .mxl) Dorico
 * exports from its import out.
 *
 * `File.Open` of a `.mid` makes no project: Dorico shows its MIDI Import
 * Options window and waits (2026-11-08). That window can't be found, read
 * or pressed through Accessibility (`import-window.ts`, FINDINGS), so the
 * job counts Dorico's windows instead: it "shows" when, after `File.Open`,
 * there is one window more than before and no new project. The job then
 * accepts it with Return, once, never retried (OK is its default button;
 * no option is changed), waits for the project, exports it as the export
 * job does (`exportProject`) and closes it unsaved. If Dorico makes the
 * project without asking, that project is taken straight to the export.
 * The same preflight, failsafe and wrap-up as the export job; the failsafe
 * can't see the import window, so one left open is named in the error.
 */
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
import { axCommand, IMPORT_WINDOW, windowCount, windowSummary } from "./import-window.js";
import { as, StepError, safeName } from "./steps.js";

export type MidiFile = { name: string; midi: Uint8Array };

/** A Standard MIDI File starts with its `MThd` header chunk (14 bytes at least). */
export const isMidi = (b: Uint8Array) =>
	b.length >= 14 && b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;

/** Dorico as `File.Open` found it: its window count and the newest project seen. */
type Before = { windows: number; floor: number };

/** The first project newer than the floor, once one is announced: `id` is null until then. */
type Made = { id: number | null; done: Promise<number | null> };

function watch(dorico: DoricoClient, floor: number, ms: number): Made {
	const made: Made = { id: null, done: Promise.resolve(null) };
	made.done = dorico
		.waitForStatus(
			(s) => typeof s.activeOpenScoreID === "number" && s.activeOpenScoreID > floor,
			ms,
		)
		.then(
			(s) => {
				made.id = s.activeOpenScoreID as number;
				return made.id;
			},
			() => null,
		);
	return made;
}

/** `made`'s project, if it comes within `ms`; null otherwise. */
const within = (made: Made, ms: number): Promise<number | null> =>
	Promise.race([made.done, Bun.sleep(ms).then(() => made.id)]);

/** Just before `File.Open` (preflight has seen no dialog, sheet or menu): what to compare with. */
async function before(deps: ExportDeps): Promise<Before> {
	await deps.dorico.status();
	return { floor: deps.dorico.highestScoreID, windows: await windowCount(deps.ax) };
}

const LATER = "if a project appears later, close it without saving";

/**
 * Wait, within `openMs`, for the import window (one window more than
 * before, no new project) or for a project Dorico made without asking.
 * Returns that project's ID, or null when the window showed.
 */
async function waitForImport(
	deps: ExportDeps,
	t: ExportTimeouts,
	was: Before,
	made: Made,
): Promise<number | null> {
	const end = Date.now() + t.openMs;
	for (;;) {
		const now = await windowCount(deps.ax);
		if (made.id !== null) return made.id;
		if (now === was.windows + 1) return null;
		if (Date.now() >= end)
			throw new StepError(
				"import",
				`Dorico's ${IMPORT_WINDOW} window didn't show within ${t.openMs} ms, and no project came; that window can't be seen through Accessibility (FINDINGS), only counted: Dorico's windows numbered ${was.windows} before File.Open, ${now} now (${await windowSummary(deps.ax)}); a ${IMPORT_WINDOW} window may be open on the Mac: Cancel it there; ${LATER}`,
			);
		await Bun.sleep(t.pollMs);
	}
}

/**
 * Accept the import window with Return: only while nothing else is open,
 * the window count is still one up, and no new project has appeared. Return
 * goes once and is never sent again. Once it is sent, any failure still
 * waits for the project and records it in `seen.project`, for `wrapUp` to
 * close; if none comes, the error says to.
 */
async function accept(
	deps: ExportDeps,
	t: ExportTimeouts,
	was: Before,
	made: Made,
	seen: { project: number | null },
): Promise<number> {
	const open = await blocking(deps.ax);
	if (open.windows.length || open.menuOpen !== null)
		throw new StepError(
			"import",
			`won't send Return with these open: ${openThings(open).join(", ")}; a ${IMPORT_WINDOW} window may be open on the Mac: Cancel it there`,
		);
	const now = await windowCount(deps.ax);
	await deps.dorico.status(); // any project announced so far has arrived
	if (made.id !== null)
		throw new StepError(
			"import",
			`a project appeared while the ${IMPORT_WINDOW} window waited; won't send Return; the window may be open on the Mac: Cancel it there`,
		);
	if (now !== was.windows + 1)
		throw new StepError(
			"import",
			`Dorico's windows numbered ${now} just before Return, not ${was.windows + 1}; won't send Return; a ${IMPORT_WINDOW} window may be open on the Mac: Cancel it there`,
		);
	try {
		await deps.activate();
		await axCommand(deps.ax, "keys", "--combo", "return");
	} catch (e) {
		// Return may have gone all the same (an answer that came too late).
		seen.project = await within(made, t.openMs);
		throw new StepError(
			"import",
			`Return into the ${IMPORT_WINDOW} window: ${(e as Error).message}${seen.project === null ? `; the window may still be open: Cancel it on the Mac; ${LATER}` : ""}`,
		);
	}
	seen.project = await within(made, t.openMs);
	if (seen.project === null)
		throw new StepError(
			"import",
			`Return didn't take or Dorico made no project within ${t.openMs} ms; the ${IMPORT_WINDOW} window may still be open: Cancel it on the Mac; ${LATER}`,
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
): Promise<ExportResult> {
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
	const seen: { project: number | null } = { project: null };
	let result: ExportResult;
	try {
		const was = await as("open", () => before(deps));
		const made = watch(deps.dorico, was.floor, 2 * t.openMs + t.dialogMs);
		await as("open", () => deps.dorico.command(`File.Open?File=${job.input}`));
		const asked = await as("import", () => waitForImport(deps, t, was, made));
		if (asked !== null) seen.project = asked;
		const project = asked ?? (await as("import", () => accept(deps, t, was, made, seen)));
		result = { name, ...(await exportProject(deps, t, project, job.out, format)) };
	} catch (e) {
		result = failed(name, e);
	}
	return wrapUp(deps, t, result, seen.project, job.dir);
}
