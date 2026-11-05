/**
 * A job: MusicXML in, the PDF Dorico engraves from it out. Each file gets a
 * fresh folder (Dorico exports beside the file it opened, and an existing
 * PDF would stop it on a dialog), is opened, exported only while it is the
 * project in front, and closed without saving.
 *
 * Kevin works in the same Dorico, so a project is closed only once it has
 * proved itself the job's (its PDF landed in the job's folder) and is the
 * one in front. Anything less leaves it open and says so: a stray project
 * is a nuisance, a closed one of his is lost work.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DoricoClient } from "./client.js";
import { DoricoError } from "./protocol.js";

export type JobFile = { name: string; xml: string };

export type FileResult =
	| { name: string; ok: true; pdf: Uint8Array }
	| { name: string; ok: false; step: Step; message: string };

type Step = "check" | "open" | "focus" | "export" | "close";

export type Timeouts = { openMs: number; exportMs: number; closeMs: number };

export const DEFAULT_TIMEOUTS: Timeouts = { openMs: 30_000, exportMs: 60_000, closeMs: 15_000 };

const POLL_MS = 250;

/** Whether `xml` looks like MusicXML: anything else could stop Dorico on an import-error dialog. */
const isMusicXml = (xml: string) => /<score-(partwise|timewise)[\s>]/.test(xml.slice(0, 2048));

/** A file name safe to write: letters, digits, dot, dash and underscore. */
const safeName = (name: string) =>
	(name.replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "_") || "score").replace(
		/(\.musicxml)?$/,
		".musicxml",
	);

class StepError extends Error {
	constructor(
		readonly step: Step,
		message: string,
	) {
		super(message);
	}
}

/** Run `work` as `step`: any failure is reported as that step's. */
async function as<T>(step: Step, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		if (e instanceof StepError) throw e;
		throw new StepError(step, e instanceof Error ? e.message : String(e));
	}
}

const LEFT_OPEN = "the job's project is left open in Dorico: close it without saving";

/** Open `file` and return the new project's ID: the first one newer than any seen before. */
async function open(client: DoricoClient, file: string, ms: number): Promise<number> {
	await client.status();
	const floor = client.highestScoreID;
	const opened = client.waitForStatus(
		(s) => typeof s.activeOpenScoreID === "number" && s.activeOpenScoreID > floor,
		ms,
	);
	opened.catch(() => {}); // the command may fail first
	await client.command(`File.Open?File=${file}`);
	const s = await opened.catch(() => {
		throw new StepError(
			"open",
			`Dorico didn't open the file within ${ms} ms; if it opens later, close it without saving`,
		);
	});
	return s.activeOpenScoreID as number;
}

const inFront = async (client: DoricoClient, id: number) =>
	(await client.status()).activeOpenScoreID === id;

/**
 * The export takes whatever project is in front. Dorico accepts
 * `Window.SwitchToLayout` but doesn't switch (two-projects.log), so a job
 * whose project isn't in front can only stop.
 */
async function focus(client: DoricoClient, id: number) {
	if (!(await inFront(client, id)))
		throw new StepError("focus", `another project is in front in Dorico; ${LEFT_OPEN}`);
}

async function exportPdf(client: DoricoClient, id: number) {
	await client.command("Print.ExportCurrentLayoutAsPDF");
	if (!(await inFront(client, id)))
		throw new StepError(
			"export",
			`focus moved to another project while exporting, which may have been exported beside its own file; ${LEFT_OPEN}`,
		);
}

/** The PDF Dorico writes into `dir`, once its size stops changing. */
async function exported(dir: string, ms: number): Promise<Uint8Array> {
	const end = Date.now() + ms;
	let last = -1;
	while (Date.now() < end) {
		const pdf = readdirSync(dir).find((f) => f.endsWith(".pdf"));
		if (pdf) {
			const size = statSync(join(dir, pdf)).size;
			if (size > 0 && size === last) return new Uint8Array(readFileSync(join(dir, pdf)));
			last = size;
		}
		await Bun.sleep(POLL_MS);
	}
	throw new StepError("export", `no PDF from Dorico within ${ms} ms`);
}

async function close(client: DoricoClient, id: number, ms: number) {
	if (!(await inFront(client, id)))
		throw new StepError("close", `another project is in front in Dorico; ${LEFT_OPEN}`);
	await client.command(`File.CloseProject?OpenScoreID=${id}&Save=false`, ms);
	// The status pushed after a close keeps the closed ID: ask afresh.
	if ((await client.status(ms)).activeOpenScoreID === id)
		throw new StepError("close", `project ${id} is still open`);
}

/** One file through Dorico. Never throws: a failure names the step that stopped. */
export async function runFile(
	client: DoricoClient,
	file: JobFile,
	workDir: string,
	timeouts: Timeouts = DEFAULT_TIMEOUTS,
): Promise<FileResult> {
	const { name } = file;
	if (!isMusicXml(file.xml))
		return {
			name,
			ok: false,
			step: "check",
			message: "not MusicXML (no <score-partwise> or <score-timewise>)",
		};
	const dir = join(workDir, "jobs", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, safeName(name));
	writeFileSync(path, file.xml);
	let id: number | null = null;
	let result: FileResult;
	try {
		const project = await as("open", () => open(client, path, timeouts.openMs));
		id = project;
		await as("focus", () => focus(client, project));
		await as("export", () => exportPdf(client, project));
		result = { name, ok: true, pdf: await as("export", () => exported(dir, timeouts.exportMs)) };
	} catch (e) {
		const err = e instanceof StepError ? e : new StepError("open", String(e));
		const message =
			id !== null && !err.message.includes(LEFT_OPEN)
				? `${err.message}; ${LEFT_OPEN}`
				: err.message;
		result = { name, ok: false, step: err.step, message };
	}
	// Only a project that produced the job's PDF is provably the job's.
	if (result.ok && id !== null) {
		const project = id;
		try {
			await as("close", () => close(client, project, timeouts.closeMs));
		} catch (e) {
			result = { name, ok: false, step: "close", message: (e as Error).message };
		}
	}
	if (result.ok) rmSync(dir, { recursive: true, force: true });
	return result;
}

/** Jobs one at a time: Dorico has one project in front. */
export class JobQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private waiting = 0;

	constructor(private readonly run: (files: JobFile[]) => Promise<FileResult[]>) {}

	get length(): number {
		return this.waiting;
	}

	add(files: JobFile[]): Promise<FileResult[]> {
		this.waiting++;
		const job = this.tail.then(() => this.run(files)).finally(() => this.waiting--);
		this.tail = job.catch(() => {});
		return job;
	}
}

/** Delete job folders (kept after failures) older than `olderThanMs`. */
export function pruneJobs(workDir: string, olderThanMs: number): void {
	const jobs = join(workDir, "jobs");
	if (!existsSync(jobs)) return;
	for (const d of readdirSync(jobs)) {
		const path = join(jobs, d);
		if (Date.now() - statSync(path).mtimeMs > olderThanMs)
			rmSync(path, { recursive: true, force: true });
	}
}

export { DoricoError };
