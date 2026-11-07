import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macBenchAx } from "../src/ax/client.js";

const work = () => mkdtempSync(join(tmpdir(), "mac-bench-ax-"));

describe("macBenchAx", () => {
	test("launches the app with the arguments and an answer file, reads it, deletes it", async () => {
		const dir = work();
		const launched: string[][] = [];
		const ax = macBenchAx("/Apps/MacBenchAX.app", dir, {
			spawn: async (cmd) => {
				launched.push(cmd);
				const out = cmd[cmd.indexOf("--out") + 1] as string;
				setTimeout(() => writeFileSync(out, JSON.stringify({ trusted: true })), 30);
				return 0;
			},
		});
		expect(await ax.run(["trusted"])).toEqual({ trusted: true });
		const cmd = launched[0] as string[];
		expect(cmd.slice(0, 6)).toEqual([
			"open",
			"-n",
			"-a",
			"/Apps/MacBenchAX.app",
			"--args",
			"trusted",
		]);
		expect(cmd[cmd.indexOf("--out") + 1]?.startsWith(join(dir, "answers/"))).toBe(true);
		expect(cmd).not.toContain("--app");
		expect(readdirSync(join(dir, "answers"))).toEqual([]);
	});

	test("each call gets its own answer file", async () => {
		const outs: string[] = [];
		const ax = macBenchAx("/A.app", work(), {
			spawn: async (cmd) => {
				const out = cmd[cmd.indexOf("--out") + 1] as string;
				outs.push(out);
				writeFileSync(out, "{}");
				return 0;
			},
		});
		await Promise.all([ax.run(["dump"]), ax.run(["dump"])]);
		expect(new Set(outs).size).toBe(2);
	});

	test("no answer within the limit is an error naming the command", async () => {
		const ax = macBenchAx("/A.app", work(), { spawn: async () => 0, timeoutMs: 100, pollMs: 10 });
		await expect(ax.run(["dump", "--depth", "1"])).rejects.toThrow(
			/MacBenchAX gave no answer to dump/,
		);
	});

	test("open failing is an error", async () => {
		const ax = macBenchAx("/A.app", work(), { spawn: async () => 1, timeoutMs: 100 });
		await expect(ax.run(["trusted"])).rejects.toThrow(/couldn't launch/);
	});

	test("an unreadable answer is an error, and the file is still removed", async () => {
		const dir = work();
		const ax = macBenchAx("/A.app", dir, {
			spawn: async (cmd) => {
				writeFileSync(cmd[cmd.indexOf("--out") + 1] as string, "not json");
				return 0;
			},
		});
		await expect(ax.run(["trusted"])).rejects.toThrow(/unreadable/);
		expect(readdirSync(join(dir, "answers"))).toEqual([]);
	});

	test("creates the work folder if it is missing", async () => {
		const dir = join(work(), "ax");
		const ax = macBenchAx("/A.app", dir, {
			spawn: async (cmd) => {
				writeFileSync(cmd[cmd.indexOf("--out") + 1] as string, "{}");
				return 0;
			},
		});
		await ax.run(["trusted"]);
		expect(existsSync(dir)).toBe(true);
	});
});
