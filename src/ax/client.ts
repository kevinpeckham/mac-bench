/**
 * Talking to MacBenchAX (`ax/main.swift`), the one program on the Mac
 * granted Accessibility. Each call launches it with `open`, so macOS treats
 * it as its own responsible process (the grant is its own, not Bun's), and
 * waits for the JSON it writes to `--out`: `open -W` can't wait for an app
 * that exits at once (FINDINGS). MacBenchAX writes only inside
 * `~/Library/Application Support/mac-bench/` (it exits 65 and answers
 * nothing otherwise), so `workDir` must be in there: answers land in its
 * `answers/` folder. It is never told which app by name: it acts on
 * Dorico's bundle ID, its only allowed app, by default.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type AxClient = { run(args: string[]): Promise<Record<string, unknown>> };

export type AxOptions = {
	/** Run a command and resolve with its exit code (default: Bun.spawn). */
	spawn?: (cmd: string[]) => Promise<number>;
	/** How long to wait for the answer file (default 10 s). */
	timeoutMs?: number;
	pollMs?: number;
};

const spawn = async (cmd: string[]) =>
	Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;

let seq = 0;

/** An AxClient for the app at `appPath`, whose answers land in `<workDir>/answers`. */
export function macBenchAx(appPath: string, workDir: string, opts: AxOptions = {}): AxClient {
	const run = opts.spawn ?? spawn;
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const pollMs = opts.pollMs ?? 50;
	return {
		async run(args) {
			const answers = join(workDir, "answers");
			mkdirSync(answers, { recursive: true, mode: 0o700 });
			const out = join(answers, `answer-${process.pid}-${Date.now()}-${seq++}.json`);
			const what = args[0] ?? "(no command)";
			// -n: a new instance each time, even if the last one hasn't quite exited.
			const code = await run(["open", "-n", "-a", appPath, "--args", ...args, "--out", out]);
			if (code !== 0)
				throw new Error(`couldn't launch MacBenchAX (${appPath}): open exited ${code}`);
			const end = Date.now() + timeoutMs;
			while (!existsSync(out) && Date.now() < end) await Bun.sleep(pollMs);
			if (!existsSync(out))
				throw new Error(
					`MacBenchAX gave no answer to ${what} within ${timeoutMs} ms; is it built (scripts/build-ax.ts), and is its work folder inside ~/Library/Application Support/mac-bench?`,
				);
			try {
				return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
			} catch {
				throw new Error(`MacBenchAX's answer to ${what} was unreadable`);
			} finally {
				rmSync(out, { force: true });
			}
		},
	};
}
