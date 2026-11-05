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

	test("an import that never appears fails at open, saying how to tidy up", async () => {
		const { client, work } = await setup({ openDelayMs: 2000 });
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "open" });
		if (!r.ok) expect(r.message).toContain("close it without saving");
	});

	test("an open while Kevin has a project open is recognised (no hasScore pushed)", async () => {
		const { fake, client, work, dir } = await setup();
		const kevin = kevinsProject(fake, dir);
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r.ok).toBe(true);
		expect([...fake.projects.keys()]).toEqual([kevin.id]);
	});

	test("Kevin bringing his own project forward during the import is never claimed", async () => {
		const { fake, client, work, dir } = await setup({ openDelayMs: 150 });
		const older = kevinsProject(fake, dir);
		const newer = join(dir, "newer.musicxml");
		writeFileSync(newer, XML("Newer"));
		fake.openDirect(newer); // in front as the job starts
		fake.onCommand = (c) => {
			if (c.startsWith("File.Open")) setTimeout(() => fake.focus(older.id), 20);
		};
		fake.onOpened = () => {
			fake.onCommand = null;
		};
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r.ok).toBe(true);
		expect(readdirSync(older.own)).toEqual(["mine.musicxml"]);
		expect(fake.projects.has(older.id)).toBe(true);
	});

	test("focus moved to Kevin's project: nothing exported, nothing of his closed, ours left open", async () => {
		const { fake, client, work, dir } = await setup();
		const kevin = kevinsProject(fake, dir);
		fake.onOpened = () => fake.focus(kevin.id);
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "focus" });
		if (!r.ok) expect(r.message).toContain("left open");
		expect(fake.commandsReceived).not.toContain("Print.ExportCurrentLayoutAsPDF");
		expect(fake.commandsReceived.some((c) => c.startsWith("File.CloseProject"))).toBe(false);
		expect(fake.projects.has(kevin.id)).toBe(true);
		expect(readdirSync(kevin.own)).toEqual(["mine.musicxml"]);
	});

	test("focus moved during the export: says so at once", async () => {
		const { fake, client, work, dir } = await setup({ writesPdf: false });
		const kevin = kevinsProject(fake, dir);
		fake.onCommand = (c) => {
			if (c === "Print.ExportCurrentLayoutAsPDF") fake.focus(kevin.id);
		};
		const started = Date.now();
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, {
			...FAST,
			exportMs: 5000,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(r).toMatchObject({ ok: false, step: "export" });
		if (!r.ok) expect(r.message).toContain("focus moved");
		expect(fake.projects.has(kevin.id)).toBe(true);
	});

	test("an export that never appears: nothing proves the project ours, so it is left open", async () => {
		const { fake, client, work } = await setup({ writesPdf: false });
		const r = await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST);
		expect(r).toMatchObject({ ok: false, step: "export" });
		if (!r.ok) expect(r.message).toContain("left open");
		expect(fake.commandsReceived.some((c) => c.startsWith("File.CloseProject"))).toBe(false);
		expect(jobFolders(work)).toHaveLength(1);
	});

	test("Dorico restarting (IDs start again) doesn't stop the next job", async () => {
		const { fake, client, work } = await setup();
		expect((await runFile(client, { name: "a.musicxml", xml: XML("A") }, work, FAST)).ok).toBe(
			true,
		);
		const port = fake.port;
		fake.kill();
		const again = new FakeDorico({ port });
		cleanup.push(() => again.stop());
		const end = Date.now() + 2000;
		while (client.state === "connected" && Date.now() < end) await Bun.sleep(10);
		while (client.state !== "connected" && Date.now() < end) await Bun.sleep(10);
		const r = await runFile(client, { name: "b.musicxml", xml: XML("B") }, work, FAST);
		expect(r.ok).toBe(true);
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
