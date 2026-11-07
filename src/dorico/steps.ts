/**
 * The steps every Dorico job shares: checking the input, a fresh job
 * folder, opening a file through Remote Control, checking its project is in
 * front, waiting for an exported file, and closing the project unsaved.
 * `job.ts` (PDF) and `export.ts` (MusicXML) build on them.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DoricoClient } from "./client.js";

export type Step =
	| "check"
	| "ax"
	| "open"
	| "focus"
	| "dialog"
	| "options"
	| "folder"
	| "export"
	| "failsafe"
	| "close";

export const POLL_MS = 250;

export const LEFT_OPEN = "the job's project is left open in Dorico: close it without saving";

/** Whether `xml` looks like MusicXML: anything else could stop Dorico on an import-error dialog. */
export const isMusicXml = (xml: string) =>
	/<score-(partwise|timewise)[\s>]/.test(xml.slice(0, 2048));

/** A file name safe to write: letters, digits, dot, dash and underscore. */
export const safeName = (name: string) =>
	(name.replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "_") || "score").replace(
		/(\.musicxml)?$/,
		".musicxml",
	);

export class StepError extends Error {
	constructor(
		readonly step: Step,
		message: string,
	) {
		super(message);
	}
}

/** Run `work` as `step`: any failure is reported as that step's. */
export async function as<T>(step: Step, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		if (e instanceof StepError) throw e;
		throw new StepError(step, e instanceof Error ? e.message : String(e));
	}
}

/** A fresh, empty folder for one file under `<workDir>/jobs`. */
export function jobDir(workDir: string): string {
	const dir = join(workDir, "jobs", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Open `file` and return the new project's ID: the first one newer than any seen before. */
export async function open(client: DoricoClient, file: string, ms: number): Promise<number> {
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

export const inFront = async (client: DoricoClient, id: number) =>
	(await client.status()).activeOpenScoreID === id;

/**
 * An export takes whatever project is in front. Dorico accepts
 * `Window.SwitchToLayout` but doesn't switch (two-projects.log), so a job
 * whose project isn't in front can only stop.
 */
export async function focus(client: DoricoClient, id: number) {
	if (!(await inFront(client, id)))
		throw new StepError("focus", `another project is in front in Dorico; ${LEFT_OPEN}`);
}

/**
 * The file `find` names, once its size stops changing (two polls alike);
 * `what` names it in the error if none settles within `ms`.
 */
export async function settled(
	find: () => string | null,
	ms: number,
	what: string,
	pollMs = POLL_MS,
): Promise<{ path: string; bytes: Uint8Array }> {
	const end = Date.now() + ms;
	let last = -1;
	let lastPath = "";
	while (Date.now() < end) {
		const path = find();
		if (path) {
			const size = statSync(path).size;
			if (size > 0 && size === last && path === lastPath)
				return { path, bytes: new Uint8Array(readFileSync(path)) };
			last = size;
			lastPath = path;
		}
		await Bun.sleep(pollMs);
	}
	throw new StepError("export", `no ${what} from Dorico within ${ms} ms`);
}

export async function close(client: DoricoClient, id: number, ms: number) {
	if (!(await inFront(client, id)))
		throw new StepError("close", `another project is in front in Dorico; ${LEFT_OPEN}`);
	await client.command(`File.CloseProject?OpenScoreID=${id}&Save=false`, ms);
	// The status pushed after a close keeps the closed ID: ask afresh.
	if ((await client.status(ms)).activeOpenScoreID === id)
		throw new StepError("close", `project ${id} is still open`);
}
