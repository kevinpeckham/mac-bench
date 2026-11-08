/** The helper on the Mac: run by launchd as `bun run helper` (varlock loads the environment). */
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV } from "varlock/env";
import { macBenchAx } from "../ax/client.js";
import { DoricoClient } from "../dorico/client.js";
import { JobQueue, pruneJobs, runFiles } from "../dorico/job.js";
import { startServer } from "./server.js";
import { tailnetAddress } from "./tailnet.js";

const WORK = join(homedir(), "Library/Application Support/mac-bench");
const KEEP_FAILED_MS = 3 * 86_400_000;

const hostname = tailnetAddress();
if (!hostname) {
	console.error(
		"mac-bench: no tailnet address (100.64.0.0/10) on this Mac — is Tailscale connected?",
	);
	process.exit(1);
}

const client = new DoricoClient({
	url: "ws://127.0.0.1:4560",
	tokenPath: join(WORK, "dorico-token"),
	clientName: "mac-bench",
});
client.start();

// MacBenchAX answers only inside WORK (ax/main.swift), here in WORK/ax/answers.
const ax = macBenchAx(join(WORK, "ax/MacBenchAX.app"), join(WORK, "ax"));
/**
 * Dorico to the front: MacBenchAX types only into Dorico, and keys go to the
 * frontmost app. `open -a` would also launch Dorico if it weren't running,
 * so this runs only while Remote Control is connected (the export job calls
 * it only after opening its file that way): keep that order.
 */
const activate = async () => {
	if (client.state !== "connected")
		throw new Error("Dorico isn't connected; not bringing it forward");
	await Bun.spawn(["open", "-a", "Dorico 6"], { stdout: "ignore", stderr: "ignore" }).exited;
	await Bun.sleep(300); // the switch lands a moment after open returns
};

const queue = new JobQueue((files, format) =>
	runFiles(files, format, { dorico: client, ax, activate }, WORK),
);

pruneJobs(WORK, KEEP_FAILED_MS);
setInterval(() => pruneJobs(WORK, KEEP_FAILED_MS), 86_400_000);

const server = startServer({
	hostname,
	port: ENV.MAC_BENCH_PORT,
	token: ENV.MAC_BENCH_TOKEN,
	client,
	queue,
	ax,
});
console.log(`mac-bench helper on ${server.url}`);
