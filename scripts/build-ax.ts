#!/usr/bin/env bun
/**
 * Build MacBenchAX on the Mac:  bun scripts/build-ax.ts [--rebuild]
 *
 * Writes ~/Library/Application Support/mac-bench/ax/MacBenchAX.app
 * (ax/Info.plist, ax/main.swift compiled with `swiftc -O`, signed ad hoc).
 * An ad-hoc signed app's Accessibility grant is tied to the build that
 * first asked for it (FINDINGS), so this refuses to replace a built app
 * unless given --rebuild, and then the grant must be reset and given again.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type BuildIo = {
	home: string;
	/** The repo, holding ax/main.swift and ax/Info.plist. */
	repo: string;
	exists: (path: string) => boolean;
	/** Run a command, returning its exit code. */
	run: (cmd: string[]) => number;
	log: (line: string) => void;
	err: (line: string) => void;
};

const BUNDLE_ID = "dev.lj.mac-bench.ax";
const USAGE = "usage: bun scripts/build-ax.ts [--rebuild]";

export function buildAx(args: string[], io: BuildIo): number {
	const unknown = args.filter((a) => a !== "--rebuild");
	if (unknown.length) {
		io.err(`unknown argument ${unknown.join(" ")}\n${USAGE}`);
		return 2;
	}
	const rebuild = args.includes("--rebuild");
	const work = join(io.home, "Library/Application Support/mac-bench");
	const app = join(work, "ax/MacBenchAX.app");
	if (io.exists(app) && !rebuild) {
		io.err(
			`MacBenchAX is already built at ${app}. A new build loses its Accessibility grant ` +
				"(it is tied to the build that asked for it), so this won't replace it. " +
				"If you mean to, run again with --rebuild and grant it again afterwards.",
		);
		return 1;
	}
	const steps: string[][] = [
		...(io.exists(app) ? [["rm", "-rf", app]] : []),
		// answers/ too: MacBenchAX writes its answer there and makes no folders
		["mkdir", "-p", join(app, "Contents/MacOS"), join(work, "ax/answers")],
		["cp", join(io.repo, "ax/Info.plist"), join(app, "Contents/Info.plist")],
		["swiftc", "-O", join(io.repo, "ax/main.swift"), "-o", join(app, "Contents/MacOS/MacBenchAX")],
		["codesign", "--force", "-s", "-", app],
	];
	for (const step of steps)
		if (io.run(step) !== 0) {
			io.err(`build-ax: ${step.join(" ")} failed`);
			return 1;
		}
	const answer = join(work, "ax/answers/request.json");
	io.log(`Built ${app}`);
	io.log("Now grant it Accessibility:");
	const todo = [
		...(rebuild
			? [`tccutil reset Accessibility ${BUNDLE_ID}   (the old grant no longer matches this build)`]
			: []),
		`open -a "${app}" --args request --out "${answer}"   (it asks macOS for the grant)`,
		"System Settings > Privacy & Security > Device Control and Data Access (macOS 27) > Accessibility: switch MacBenchAX on",
		'From the VM, bin/mac-bench dorico --health should then say "ax": { "trusted": true }',
	];
	todo.forEach((line, i) => {
		io.log(`  ${i + 1}. ${line}`);
	});
	return 0;
}

if (import.meta.main)
	process.exit(
		buildAx(process.argv.slice(2), {
			home: homedir(),
			repo: resolve(import.meta.dir, ".."),
			exists: existsSync,
			run: (cmd) => Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1,
			log: (s) => console.log(s),
			err: (s) => console.error(s),
		}),
	);
