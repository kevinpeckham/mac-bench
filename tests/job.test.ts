import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { JobQueue, pruneJobs, runFile, type Timeouts } from "../src/dorico/job.js";
import { FakeDorico, type FakeOptions } from "./fake-dorico.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup.splice(0)) f();
});

const FAST: Timeouts = { openMs: 400, exportMs: 400, closeMs: 400 };
const XML = (title: string) =>
	`<?xml version="1.0"?>\n<score-partwise version="4.0"><work><work-title>${title}</work-title></work></score-partwise>\n`;

async function setup(opts: FakeOptions = {}) {
	const fake = new FakeDorico(opts);
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-job-"));
	writeFileSync(join(dir, "token"), "known-token");
	const client = new DoricoClient({
		url: fake.url,
		tokenPath: join(dir, "token"),
		clientName: "mac-bench",
		retryMs: 50,
	});
	client.start();
	cleanup.push(() => {
		client.stop();
		fake.stop();
	});
	const end = Date.now() + 2000;
	while (client.state !== "connected" && Date.now() < end) await Bun.sleep(10);
	const work = join(dir, "work");
	return { fake, client, work, dir };
}

/** One of Kevin's own projects, already open in Dorico. */
function kevinsProject(fake: FakeDorico, dir: string) {
	const own = join(dir, "kevin");
	mkdirSync(own);
	const file = join(own, "mine.musicxml");
	writeFileSync(file, XML("Mine"));
	return { id: fake.openDirect(file), own };
}

const jobFolders = (work: string) =>
	existsSync(join(work, "jobs")) ? readdirSync(join(work, "jobs")) : [];

describe("runFile", () => {
	test("exports a PDF and closes the project", async () => {
		const { fake, client, work } = await setup();
		const r = await runFile(client, { name: "horns.musicxml", xml: XML("Horn Test") }, work, FAST);
		expect(r.ok).toBe(true);
		if (r.ok) expect(new TextDecoder().decode(r.pdf.slice(0, 4))).toBe("%PDF");
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toEqual([]);
	});

	test("rejects non-MusicXML before Dorico sees it", async () => {
		const { fake, client, work } = await setup();
		const r = await runFile(client, { name: "notes.txt", xml: "hello" }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "check" });
		expect(fake.commandsReceived).toEqual([]);
	});

	test("an import that never appears fails at open", async () => {
		const { client, work } = await setup({ openDelayMs: 2000 });
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "open" });
	});

	test("focus moved to another project: the job's own project is brought back and exported", async () => {
		const { fake, client, work, dir } = await setup();
		const kevin = kevinsProject(fake, dir);
		fake.onOpened = () => fake.focus(kevin.id);
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r.ok).toBe(true);
		expect(
			fake.commandsReceived.some((c) => c.startsWith("Window.SwitchToLayout?OpenScoreID=36&")),
		).toBe(true);
		expect([...fake.projects.keys()]).toEqual([kevin.id]);
		expect(readdirSync(kevin.own)).toEqual(["mine.musicxml"]);
	});

	test("focus can't be restored: nothing is exported, only the job's project is closed", async () => {
		const { fake, client, work, dir } = await setup({ honoursSwitch: false });
		const kevin = kevinsProject(fake, dir);
		fake.onOpened = () => fake.focus(kevin.id);
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "focus" });
		expect(fake.commandsReceived).not.toContain("Print.ExportCurrentLayoutAsPDF");
		expect([...fake.projects.keys()]).toEqual([kevin.id]);
		expect(readdirSync(kevin.own)).toEqual(["mine.musicxml"]);
	});

	test("an export that never appears fails at export, closes, and keeps the folder", async () => {
		const { fake, client, work } = await setup({ writesPdf: false });
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "export" });
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toHaveLength(1);
	});

	test("Dorico going away mid-job fails the job without throwing", async () => {
		const { fake, client, work } = await setup();
		fake.onOpened = () => fake.kill();
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
	});
});

describe("JobQueue", () => {
	test("runs jobs one at a time", async () => {
		const { fake, client, work } = await setup();
		const queue = new JobQueue((files) =>
			Promise.all(files.map((f) => runFile(client, f, work, FAST))),
		);
		const [a, b] = await Promise.all([
			queue.add([{ name: "a.musicxml", xml: XML("A") }]),
			queue.add([{ name: "b.musicxml", xml: XML("B") }]),
		]);
		expect([a[0]?.ok, b[0]?.ok]).toEqual([true, true]);
		const c = fake.commandsReceived;
		const firstClose = c.findIndex((x) => x.startsWith("File.CloseProject"));
		const secondOpen = c.findLastIndex((x) => x.startsWith("File.Open"));
		expect(firstClose).toBeLessThan(secondOpen);
	});

	test("a job's files run one after another too", async () => {
		const { fake, client, work } = await setup();
		const queue = new JobQueue(async (files) => {
			const out = [];
			for (const f of files) out.push(await runFile(client, f, work, FAST));
			return out;
		});
		const results = await queue.add([
			{ name: "a.musicxml", xml: XML("A") },
			{ name: "b.musicxml", xml: XML("B") },
		]);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(fake.commandsReceived.filter((c) => c.startsWith("File.Open"))).toHaveLength(2);
	});
});

test("pruneJobs removes old folders only", () => {
	const work = mkdtempSync(join(tmpdir(), "mac-bench-prune-"));
	for (const name of ["old", "new"]) mkdirSync(join(work, "jobs", name), { recursive: true });
	const weekAgo = new Date(Date.now() - 7 * 86_400_000);
	utimesSync(join(work, "jobs", "old"), weekAgo, weekAgo);
	pruneJobs(work, 3 * 86_400_000);
	expect(readdirSync(join(work, "jobs"))).toEqual(["new"]);
});
