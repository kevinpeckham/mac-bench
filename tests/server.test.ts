import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { type JobFile, JobQueue, runFile } from "../src/dorico/job.js";
import { startServer } from "../src/helper/server.js";
import { tailnetAddress } from "../src/helper/tailnet.js";
import { FakeDorico } from "./fake-dorico.js";

const TOKEN = "test-bearer-token";
const XML = (title: string) =>
	`<score-partwise version="4.0"><work><work-title>${title}</work-title></work></score-partwise>`;
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup.splice(0)) f();
});

async function helper(maxBytes?: number) {
	const fake = new FakeDorico();
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-server-"));
	writeFileSync(join(dir, "token"), "known-token");
	const client = new DoricoClient({
		url: fake.url,
		tokenPath: join(dir, "token"),
		clientName: "mac-bench",
		retryMs: 50,
	});
	client.start();
	const fast = { openMs: 400, exportMs: 400, closeMs: 400 };
	const queue = new JobQueue(async (files: JobFile[]) => {
		const out = [];
		for (const f of files) out.push(await runFile(client, f, join(dir, "work"), fast));
		return out;
	});
	const server = startServer({
		hostname: "127.0.0.1",
		port: 0,
		token: TOKEN,
		client,
		queue,
		...(maxBytes ? { maxBytes } : {}),
	});
	cleanup.push(() => {
		server.stop();
		client.stop();
		fake.stop();
	});
	const end = Date.now() + 2000;
	while (client.state !== "connected" && Date.now() < end) await Bun.sleep(10);
	return { fake, client, url: server.url };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

function post(url: string, files: Record<string, string>, headers: Record<string, string> = auth) {
	const form = new FormData();
	for (const [name, xml] of Object.entries(files)) form.append("file", new File([xml], name));
	return fetch(`${url}/jobs`, { method: "POST", body: form, headers });
}

describe("tailnetAddress", () => {
	const nic = (address: string, internal = false) => ({
		address,
		netmask: "255.255.255.0",
		family: "IPv4" as const,
		mac: "00:00:00:00:00:00",
		internal,
		cidr: null,
	});
	test("picks the 100.64/10 address", () => {
		expect(
			tailnetAddress({
				lo0: [nic("127.0.0.1", true)],
				en0: [nic("192.168.1.20")],
				utun4: [nic("100.109.247.68")],
			}),
		).toBe("100.109.247.68");
	});
	test("none: null (100.128.x is outside the tailnet range)", () => {
		expect(tailnetAddress({ en0: [nic("192.168.1.20")], en1: [nic("100.128.0.1")] })).toBeNull();
	});
});

describe("the helper", () => {
	test("401 without the token, and with a wrong one", async () => {
		const { url } = await helper();
		expect((await fetch(`${url}/health`)).status).toBe(401);
		expect(
			(await fetch(`${url}/health`, { headers: { Authorization: "Bearer nope" } })).status,
		).toBe(401);
		expect((await post(url, { "a.musicxml": XML("A") }, {})).status).toBe(401);
	});

	test("health reports Dorico's state", async () => {
		const { url, fake, client } = await helper();
		const health = await (await fetch(`${url}/health`, { headers: auth })).json();
		expect(health).toMatchObject({ dorico: "connected", queue: 0 });
		expect(typeof health.helper).toBe("string");
		fake.kill();
		const end = Date.now() + 2000;
		while (client.state !== "not running" && Date.now() < end) await Bun.sleep(10);
		expect((await (await fetch(`${url}/health`, { headers: auth })).json()).dorico).toBe(
			"not running",
		);
	});

	test("a job returns each file's PDF", async () => {
		const { url } = await helper();
		const res = await post(url, { "a.musicxml": XML("A"), "b.musicxml": XML("B") });
		expect(res.status).toBe(200);
		const { results } = await res.json();
		expect(results.map((r: { name: string; ok: boolean }) => [r.name, r.ok])).toEqual([
			["a.musicxml", true],
			["b.musicxml", true],
		]);
		expect(Buffer.from(results[0].pdf, "base64").toString().slice(0, 4)).toBe("%PDF");
	});

	test("a failed file names its step", async () => {
		const { url } = await helper();
		const { results } = await (await post(url, { "notes.txt": "hello" })).json();
		expect(results[0]).toMatchObject({ name: "notes.txt", ok: false, step: "check" });
	});

	test("concurrent jobs queue", async () => {
		const { url, fake } = await helper();
		const [a, b] = await Promise.all([
			post(url, { "a.musicxml": XML("A") }),
			post(url, { "b.musicxml": XML("B") }),
		]);
		expect([(await a.json()).results[0].ok, (await b.json()).results[0].ok]).toEqual([true, true]);
		const c = fake.commandsReceived;
		expect(c.findIndex((x) => x.startsWith("File.CloseProject"))).toBeLessThan(
			c.findLastIndex((x) => x.startsWith("File.Open")),
		);
	});

	test("413 for an oversized body", async () => {
		const { url } = await helper(1000);
		const res = await post(url, { "big.musicxml": XML("x".repeat(5000)) });
		expect(res.status).toBe(413);
	});

	test("400 with no files", async () => {
		const { url } = await helper();
		const res = await fetch(`${url}/jobs`, { method: "POST", body: new FormData(), headers: auth });
		expect(res.status).toBe(400);
	});
});
