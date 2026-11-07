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
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoricoClient } from "./client.js";
import { DoricoError } from "./protocol.js";
import {
	as,
	close,
	focus,
	inFront,
	isMusicXml,
	jobDir,
	LEFT_OPEN,
	open,
	type Step,
	StepError,
	safeName,
	settled,
} from "./steps.js";

export type JobFile = { name: string; xml: string };

export type FileResult =
	| { name: string; ok: true; pdf: Uint8Array }
	| { name: string; ok: false; step: Step; message: string };

export type Timeouts = { openMs: number; exportMs: number; closeMs: number };

export const DEFAULT_TIMEOUTS: Timeouts = { openMs: 30_000, exportMs: 60_000, closeMs: 15_000 };

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
	const find = () => {
		const pdf = readdirSync(dir).find((f) => f.endsWith(".pdf"));
		return pdf ? join(dir, pdf) : null;
	};
	return (await settled(find, ms, "PDF")).bytes;
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
	const dir = jobDir(workDir);
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
