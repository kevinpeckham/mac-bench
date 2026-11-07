import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dorico } from "../src/cli/dorico.js";
import { DoricoClient } from "../src/dorico/client.js";
import { type ExportFormat, exportFile } from "../src/dorico/export.js";
import { type JobFile, JobQueue, runFile } from "../src/dorico/job.js";
import { startServer } from "../src/helper/server.js";
import { DORICO, FakeAx } from "./fake-ax.js";
import { FakeDorico } from "./fake-dorico.js";

const TOKEN = "cli-token";
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup.splice(0)) f();
});

async function helper() {
	const fake = new FakeDorico();
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-cli-"));
	writeFileSync(join(dir, "token"), "known-token");
	const client = new DoricoClient({
		url: fake.url,
		tokenPath: join(dir, "token"),
		clientName: "mac-bench",
		retryMs: 50,
	});
	client.start();
	const fast = { openMs: 400, exportMs: 400, closeMs: 400 };
	const ax = new FakeAx({ title: "Horns" });
	const deps = {
		dorico: client,
		ax,
		activate: async () => {
			ax.front = DORICO;
		},
	};
	const slow = { ...fast, dialogMs: 300, settleMs: 1, pollMs: 5 };
	const queue = new JobQueue(async (files: JobFile[], format?: ExportFormat) => {
		const out = [];
		for (const f of files)
			out.push(
				format
					? await exportFile(deps, f, format, join(dir, "work"), slow)
					: await runFile(client, f, join(dir, "work"), fast),
			);
		return out;
	});
	const server = startServer({ hostname: "127.0.0.1", port: 0, token: TOKEN, client, queue, ax });
	cleanup.push(() => {
		server.stop();
		client.stop();
		fake.stop();
	});
	const end = Date.now() + 2000;
	while (client.state !== "connected" && Date.now() < end) await Bun.sleep(10);
	return { url: server.url, dir };
}

/** Run the command, capturing its output. */
async function run(args: string[], url: string, token = TOKEN) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await dorico(args, { url, token, out: (s) => out.push(s), err: (s) => err.push(s) });
	return { code, out, err };
}

function charts(dir: string, files: Record<string, string>) {
	return Object.entries(files).map(([name, xml]) => {
		const path = join(dir, name);
		writeFileSync(path, xml);
		return path;
	});
}
const XML = (title: string) =>
	`<score-partwise version="4.0"><work><work-title>${title}</work-title></work></score-partwise>`;

describe("mac-bench dorico", () => {
	test("writes each PDF and prints its path", async () => {
		const { url, dir } = await helper();
		const out = join(dir, "out");
		const files = charts(dir, { "horns.musicxml": XML("Horns"), "piano.musicxml": XML("Piano") });
		const r = await run([...files, "--out", out], url);
		expect(r.code).toBe(0);
		expect(r.out).toEqual([`ok ${join(out, "horns.pdf")}`, `ok ${join(out, "piano.pdf")}`]);
		expect(readFileSync(join(out, "horns.pdf"), "utf8").slice(0, 4)).toBe("%PDF");
	});

	test("exits 1 and names the failed step", async () => {
		const { url, dir } = await helper();
		const files = charts(dir, { "notes.musicxml": "hello", "ok.musicxml": XML("Ok") });
		const r = await run([...files, "--out", join(dir, "out")], url);
		expect(r.code).toBe(1);
		expect(r.out[0]).toMatch(/^FAIL notes\.musicxml: check: not MusicXML/);
		expect(r.out[1]).toStartWith("ok ");
	});

	test("--health prints the helper's health", async () => {
		const { url } = await helper();
		const r = await run(["--health"], url);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out.join("\n"))).toMatchObject({ dorico: "connected" });
	});

	test("an unreachable helper names MAC_BENCH_URL", async () => {
		const r = await run(["--health"], "http://127.0.0.1:9");
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toContain("MAC_BENCH_URL");
	});

	test("a refused token says so", async () => {
		const { url } = await helper();
		const r = await run(["--health"], url, "wrong");
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toContain("MAC_BENCH_TOKEN");
	});

	test("a missing file fails before anything is sent", async () => {
		const { url, dir } = await helper();
		const r = await run([join(dir, "nope.musicxml")], url);
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toContain("nope.musicxml");
		expect(existsSync(join(dir, "dorico-runs"))).toBe(false);
	});

	test("no arguments prints usage", async () => {
		const r = await run([], "http://127.0.0.1:9");
		expect(r.code).toBe(2);
		expect(r.err.join("\n")).toContain("usage");
	});

	test("--export musicxml writes <base>.dorico.musicxml", async () => {
		const { url, dir } = await helper();
		const out = join(dir, "out");
		const files = charts(dir, { "horns.musicxml": XML("Horns"), "piano.xml": XML("Piano") });
		const r = await run(["--export", "musicxml", ...files, "--out", out], url);
		expect(r.code).toBe(0);
		expect(r.out).toEqual([
			`ok ${join(out, "horns.dorico.musicxml")}`,
			`ok ${join(out, "piano.dorico.musicxml")}`,
		]);
		expect(readFileSync(join(out, "horns.dorico.musicxml"), "utf8")).toStartWith("fake .musicxml");
	});

	test("--export mxl writes <base>.dorico.mxl, numbered on a clash", async () => {
		const { url, dir } = await helper();
		const out = join(dir, "out");
		const [a] = charts(dir, { "horns.musicxml": XML("Horns") });
		const r = await run(["--out", out, "--export", "mxl", a as string, a as string], url);
		expect(r.code).toBe(0);
		expect(r.out).toEqual([
			`ok ${join(out, "horns.dorico.mxl")}`,
			`ok ${join(out, "horns-2.dorico.mxl")}`,
		]);
	});

	test("--export with another format, or none, prints usage", async () => {
		for (const args of [
			["--export", "pdf", "a.musicxml"],
			["a.musicxml", "--export"],
		]) {
			const r = await run(args, "http://127.0.0.1:9");
			expect(r.code).toBe(2);
			expect(r.err.join("\n")).toContain("--export musicxml|mxl");
		}
	});

	test("--health shows whether exports will work", async () => {
		const { url } = await helper();
		const r = await run(["--health"], url);
		expect(JSON.parse(r.out.join("\n")).ax).toEqual({ trusted: true });
	});
});
