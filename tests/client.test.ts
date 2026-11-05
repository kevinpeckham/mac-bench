import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { DoricoError } from "../src/dorico/protocol.js";
import { FakeDorico } from "./fake-dorico.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup.splice(0)) f();
});

/** A started client against `fake`, with a token file holding `token` (none if null). */
function clientFor(url: string, token: string | null = "known-token", retryMs = 100) {
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-"));
	const tokenPath = join(dir, "dorico-token");
	if (token !== null) writeFileSync(tokenPath, token);
	const client = new DoricoClient({
		url,
		tokenPath,
		clientName: "mac-bench",
		retryMs,
		allowWaitMs: 300,
	});
	client.start();
	cleanup.push(() => client.stop());
	return { client, tokenPath, dir };
}

function fake(opts: ConstructorParameters<typeof FakeDorico>[0] = {}) {
	const f = new FakeDorico(opts);
	cleanup.push(() => f.stop());
	return f;
}

async function until(check: () => boolean, ms = 2000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await Bun.sleep(10);
	}
}

describe("DoricoClient", () => {
	test("connects with a saved token", async () => {
		const { client } = clientFor(fake().url);
		await until(() => client.state === "connected" && client.version !== null);
		expect(client.version).toEqual({ variant: "Elements", number: "6.2.31" });
	});

	test("first connect saves the token Dorico issues", async () => {
		const { client, tokenPath } = clientFor(fake().url, null);
		await until(() => client.state === "connected");
		expect(readFileSync(tokenPath, "utf8")).toBe("issued-token");
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
	});

	test("unknown token waits for Allow and fails commands at once", async () => {
		const { client } = clientFor(fake().url, "stale-token");
		await until(() => client.state === "waiting for Allow in Dorico");
		const started = Date.now();
		const err = await client.command("File.Open?File=/x").catch((e) => e);
		expect(err).toBeInstanceOf(DoricoError);
		expect(err.message).toContain("Allow");
		expect(Date.now() - started).toBeLessThan(100);
	});

	test("not running: commands fail at once", async () => {
		const f = fake();
		const url = f.url;
		f.stop();
		const { client } = clientFor(url);
		await Bun.sleep(150);
		expect(client.state).toBe("not running");
		const err = await client.command("File.Open?File=/x").catch((e) => e);
		expect(err).toBeInstanceOf(DoricoError);
		expect(err.message).toContain("not running");
	});

	test("reconnects when Dorico comes back", async () => {
		const first = fake();
		const port = first.port;
		const { client } = clientFor(first.url);
		await until(() => client.state === "connected");
		first.kill();
		await until(() => client.state === "not running");
		fake({ port });
		await until(() => client.state === "connected", 1000);
	});

	test("an unknown command rejects with kUnknownCommand", async () => {
		const { client } = clientFor(fake().url);
		await until(() => client.state === "connected");
		const err = await client.command("Foo.Bar").catch((e) => e);
		expect(err).toBeInstanceOf(DoricoError);
		expect(err.message).toContain("kUnknownCommand");
	});

	test("waitForStatus sees pushed statuses", async () => {
		const { client } = clientFor(fake().url);
		await until(() => client.state === "connected");
		const opened = client.waitForStatus(
			(s) => s.hasScore === true && s.activeOpenScoreID !== undefined,
			2000,
		);
		await client.command("File.Open?File=/tmp/none.musicxml");
		expect((await opened).activeOpenScoreID).toBe(35);
		expect((await client.status()).activeOpenScoreID).toBe(35);
		expect((await client.layouts())[0]).toMatchObject({
			layoutID: 0,
			layoutType: "kFullScoreLayout",
		});
	});

	test("a reply that comes after its timeout never answers the next request", async () => {
		const f = fake();
		const { client } = clientFor(f.url, "known-token", 50);
		await until(() => client.state === "connected" && client.version !== null);
		f.replyDelayMs = 300;
		await expect(client.command("Nope.Unknown", 100)).rejects.toThrow("no reply");
		f.replyDelayMs = 0;
		await until(() => client.state !== "connected");
		await until(() => client.state === "connected");
		await Bun.sleep(300); // the late kUnknownCommand has arrived by now
		await client.command("File.Open?File=/nowhere.musicxml"); // kOK, not the late kUnknownCommand
	});

	test("waitForStatus times out with a DoricoError", async () => {
		const { client } = clientFor(fake().url);
		await until(() => client.state === "connected");
		const err = await client.waitForStatus(() => false, 50).catch((e) => e);
		expect(err).toBeInstanceOf(DoricoError);
	});
});

describe("the fake", () => {
	/** The first recorded Dorico reply matching `pick`, from probe.log. */
	function recorded(pick: (m: Record<string, unknown>) => boolean) {
		const log = readFileSync(join(import.meta.dir, "recordings", "probe.log"), "utf8");
		for (const line of log.split("\n")) {
			const json = / <- (\{.*\})$/.exec(line)?.[1];
			if (!json) continue;
			const m = JSON.parse(json);
			if (pick(m)) return m;
		}
		throw new Error("not in the recording");
	}
	const keys = (m: Record<string, unknown>) => Object.keys(m).sort();

	test("matches the recordings", async () => {
		const f = fake();
		const { client } = clientFor(f.url);
		await until(() => client.state === "connected");
		await client.command("Foo.Bar").catch(() => {});
		await client.command("File.Open?File=/tmp/none.musicxml");
		await client.waitForStatus((s) => s.activeOpenScoreID !== undefined, 2000);
		await client.layouts();
		for (const pick of [
			(m: Record<string, unknown>) => m.code === "kConnected",
			(m: Record<string, unknown>) => m.code === "kOK",
			(m: Record<string, unknown>) => m.code === "kError",
		])
			expect(keys(f.sent.find(pick) ?? {})).toEqual(keys(recorded(pick)));
		const layouts = (m: Record<string, unknown>) => m.message === "layoutslist";
		expect(keys(f.sent.find(layouts) ?? {})).toEqual(keys(recorded(layouts)));
		expect(existsSync(join(import.meta.dir, "recordings", "probe.log"))).toBe(true);
	});
});
