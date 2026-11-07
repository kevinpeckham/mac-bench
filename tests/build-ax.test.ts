import { describe, expect, test } from "bun:test";
import { type BuildIo, buildAx } from "../scripts/build-ax.js";

const HOME = "/Users/administrator";
const APP = `${HOME}/Library/Application Support/mac-bench/ax/MacBenchAX.app`;

function io(exists: boolean, fail?: string) {
	const ran: string[][] = [];
	const out: string[] = [];
	const err: string[] = [];
	const it: BuildIo = {
		home: HOME,
		repo: "/repo",
		exists: () => exists,
		run: (cmd) => {
			ran.push(cmd);
			return cmd[0] === fail ? 1 : 0;
		},
		log: (s) => out.push(s),
		err: (s) => err.push(s),
	};
	return { it, ran, out: () => out.join("\n"), err: () => err.join("\n") };
}

describe("build-ax", () => {
	test("builds, signs ad hoc, and says how to grant", () => {
		const t = io(false);
		expect(buildAx([], t.it)).toBe(0);
		expect(t.ran.map((c) => c[0])).toEqual(["mkdir", "cp", "swiftc", "codesign"]);
		expect(t.ran[2]).toEqual([
			"swiftc",
			"-O",
			"/repo/ax/main.swift",
			"-o",
			`${APP}/Contents/MacOS/MacBenchAX`,
		]);
		expect(t.ran[3]).toEqual(["codesign", "--force", "-s", "-", APP]);
		expect(t.out()).toContain("--args request --out");
		expect(t.out()).toContain("Device Control and Data Access");
		expect(t.out()).not.toContain("tccutil");
	});

	test("refuses to overwrite a built app without --rebuild", () => {
		const t = io(true);
		expect(buildAx([], t.it)).toBe(1);
		expect(t.ran).toEqual([]);
		expect(t.err()).toContain("--rebuild");
		expect(t.err()).toContain("grant");
	});

	test("--rebuild replaces it and says to reset and re-grant", () => {
		const t = io(true);
		expect(buildAx(["--rebuild"], t.it)).toBe(0);
		expect(t.ran[0]).toEqual(["rm", "-rf", APP]);
		expect(t.out()).toContain("tccutil reset Accessibility dev.lj.mac-bench.ax");
		expect(t.out()).toContain("--args request");
	});

	test("a failing step stops the build", () => {
		const t = io(false, "swiftc");
		expect(buildAx([], t.it)).toBe(1);
		expect(t.ran.map((c) => c[0])).toEqual(["mkdir", "cp", "swiftc"]);
		expect(t.err()).toContain("swiftc");
	});

	test("an unknown argument prints usage", () => {
		const t = io(false);
		expect(buildAx(["--force"], t.it)).toBe(2);
		expect(t.err()).toContain("usage");
	});
});
