/**
 * An export job: MusicXML in, the MusicXML (or .mxl) Dorico writes from it
 * out. Remote Control has no export that takes a path (FINDINGS), so the job
 * opens the file through Remote Control as job.ts does, then answers
 * Dorico's own Export MusicXML dialog through MacBenchAX (macOS
 * Accessibility), as the spike of 2026-11-07 did.
 *
 * Each file gets a fresh job folder: `in/` holds the input, `out/` receives
 * the export. Whatever happens, a failsafe cancels every dialog left open
 * and the project is closed unsaved, by its ID, while it is in front. The
 * only text ever typed is the folder path; the only OK ever pressed is the
 * Export MusicXML dialog's.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AxClient } from "../ax/client.js";
import type { DoricoClient } from "./client.js";
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

type AxNode = {
	AXRole?: string;
	AXSubrole?: string;
	AXTitle?: string;
	AXValue?: unknown;
	AXIdentifier?: string;
	children?: AxNode[];
};

/** Run a MacBenchAX command; an `error` in its answer, or `ok: false`, throws. */
async function ax(client: AxClient, ...args: string[]): Promise<Record<string, unknown>> {
	const r = await client.run(args);
	if (typeof r.error === "string") throw new Error(`MacBenchAX ${args[0]}: ${r.error}`);
	if (r.ok === false) throw new Error(`MacBenchAX ${args.join(" ")} didn't take`);
	return r;
}

async function windows(client: AxClient, depth = 12): Promise<AxNode[]> {
	const r = await ax(client, "dump", "--depth", String(depth));
	return Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];
}

/** `n` and everything under it, in the order the dump lists them. */
const flat = (n: AxNode, acc: AxNode[] = []): AxNode[] => {
	acc.push(n);
	for (const c of n.children ?? []) flat(c, acc);
	return acc;
};

const dialogs = (ws: AxNode[]) => ws.filter((w) => w.AXSubrole !== "AXStandardWindow");
const dialog = (ws: AxNode[], title: string) =>
	ws.find((w) => w.AXSubrole === "AXDialog" && w.AXTitle === title);
const titleOf = (w: AxNode) => w.AXTitle || w.AXSubrole || w.AXRole || "untitled";
const noSlash = (p: string) => p.replace(/\/+$/, "");

/**
 * Poll the windows until `pick` finds something, for at most `ms`; then
 * stop as `step`, saying `failed(last windows)`.
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
		const ws = await windows(client);
		const found = pick(ws);
		if (found !== undefined) return found;
		if (Date.now() >= end) throw new StepError(step, failed(ws));
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

/** The dialog's checkboxes, in order. */
const boxes = (d: AxNode) => flat(d).filter((n) => n.AXRole === "AXCheckBox");
const value = (d: AxNode, title: string) => {
	const box = boxes(d).find((b) => b.AXTitle === title);
	if (!box) throw new StepError("options", `no "${title}" checkbox in Dorico's ${EXPORT} dialog`);
	return Number(box.AXValue);
};

/** Make the dialog's checkboxes as `format` needs, pressing only those that differ. */
async function options(client: AxClient, t: ExportTimeouts, format: ExportFormat) {
	// The wanted format on before the other goes off: Dorico may insist on one.
	const wanted: [string, number][] = [
		[format === "mxl" ? MXL : XML, 1],
		[format === "mxl" ? XML : MXL, 0],
		[FOLDER, 0],
		[SEPARATE, 0],
		[FULL_SCORE, 1],
	];
	let d = await exportDialog(client, t, "options");
	for (const [title, want] of wanted) {
		if (value(d, title) === want) continue;
		await ax(client, "press", "--title", title, "--role", "AXCheckBox");
		d = await exportDialog(client, t, "options");
	}
	for (const [title, want] of wanted) {
		const v = value(d, title);
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

/** Point the dialog's "Export to:" at `out` through the Open panel. */
async function folder(
	client: AxClient,
	t: ExportTimeouts,
	out: string,
	activate: () => Promise<void>,
) {
	// MacBenchAX posts keys only while Dorico is frontmost: bring it forward before each.
	const keys = async (combo: string) => {
		await activate();
		await ax(client, "keys", "--combo", combo);
	};
	await ax(client, "press", "--title", FOLDER_BUTTON, "--role", "AXButton");
	const panel = (ws: AxNode[]) => dialog(ws, "Open");
	await waitFor(client, t, "folder", panel, () => "the folder picker (Open) didn't show");
	await keys("cmd+shift+g");
	const sheet = (ws: AxNode[]) => {
		const p = panel(ws);
		const s = p && flat(p).find((n) => n.AXRole === "AXSheet");
		return s && flat(s).some((n) => n.AXRole === "AXTextField") ? s : undefined;
	};
	await waitFor(client, t, "folder", sheet, () => "the Go to Folder sheet didn't show");
	await ax(client, "set", "--sheet", "--value", `${out}/`);
	await keys("return");
	const where = (ws: AxNode[]) => {
		const p = panel(ws);
		return p && flat(p).find((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === "Where:");
	};
	await waitFor(
		client,
		t,
		"folder",
		(ws) => (!sheet(ws) && where(ws)?.AXValue === basename(out) ? true : undefined),
		(ws) =>
			`the folder picker didn't go to the job's folder (Where: shows "${String(where(ws)?.AXValue ?? "nothing")}")`,
	);
	await ax(client, "press", "--title", "Choose", "--role", "AXButton");
	const label = (ws: AxNode[]) => {
		const d = dialog(ws, EXPORT);
		const l = d && flat(d).find((n) => n.AXIdentifier?.endsWith("folderPathLabel"));
		return l ? String(l.AXValue ?? "") : undefined;
	};
	await waitFor(
		client,
		t,
		"folder",
		(ws) =>
			!panel(ws) && label(ws) !== undefined && noSlash(label(ws) ?? "") === out ? true : undefined,
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
	const open = dialogs(await windows(deps.ax));
	if (open.length !== 1 || open[0]?.AXTitle !== EXPORT)
		throw new StepError(
			"export",
			`won't press OK with these open: ${open.map(titleOf).join(", ") || "nothing"}`,
		);
	await ax(deps.ax, "press", "--title", "OK", "--role", "AXButton");
	const got = await settled(() => pick(out, ext), t.exportMs, `${ext} file`, t.pollMs);
	if (!(await inFront(deps.dorico, id)))
		throw new StepError("export", "focus moved to another project while exporting");
	return got;
}

/**
 * Cancel every dialog Dorico has open: up to four rounds of `dismiss`, from
 * the second with Escape too. Returns what is still open, as an error, or null.
 */
async function failsafe(deps: ExportDeps, t: ExportTimeouts): Promise<string | null> {
	try {
		for (let round = 0; round < 4; round++) {
			if (dialogs(await windows(deps.ax, 1)).length === 0) return null;
			await ax(deps.ax, "dismiss").catch(() => {});
			await Bun.sleep(t.settleMs);
			if (round > 0 && dialogs(await windows(deps.ax, 1)).length > 0) {
				await deps.activate().catch(() => {});
				await ax(deps.ax, "keys", "--combo", "escape").catch(() => {});
				await Bun.sleep(t.settleMs);
			}
		}
		const left = dialogs(await windows(deps.ax, 1));
		return left.length
			? `a Dorico dialog is still open: ${left.map(titleOf).join(", ")}; dismiss it by screen sharing`
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
	try {
		if ((await deps.ax.run(["trusted"])).trusted !== true)
			return { name, ok: false, step: "ax", message: NOT_TRUSTED };
	} catch (e) {
		return { name, ok: false, step: "ax", message: (e as Error).message };
	}
	const dir = jobDir(workDir);
	const out = join(dir, "out");
	mkdirSync(join(dir, "in"));
	mkdirSync(out);
	const path = join(dir, "in", safeName(name));
	writeFileSync(path, file.xml);
	const ext = format === "mxl" ? ".mxl" : ".musicxml";
	let id: number | null = null;
	let result: ExportResult;
	try {
		const project = await as("open", () => open(deps.dorico, path, t.openMs));
		id = project;
		await as("focus", () => focus(deps.dorico, project));
		await as("dialog", async () => {
			await deps.activate();
			await ax(deps.ax, "menu", "--path", MENU);
			await exportDialog(deps.ax, t, "dialog");
		});
		await as("options", () => options(deps.ax, t, format));
		await as("folder", () => folder(deps.ax, t, out, deps.activate));
		const got = await as("export", () => exportTo(deps, t, project, out, ext));
		result = { name, ok: true, file: got.bytes, exported: basename(got.path) };
	} catch (e) {
		const err = e instanceof StepError ? e : new StepError("open", String(e));
		result = { name, ok: false, step: err.step, message: err.message };
	}
	// Whatever happened: the failsafe, then the close.
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
	if (result.ok) rmSync(dir, { recursive: true, force: true });
	return result;
}
