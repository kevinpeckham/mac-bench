/** `mac-bench <command>` on the VM; run through bin/mac-bench (varlock loads the environment). */
import { ENV } from "varlock/env";
import { dorico, USAGE } from "./dorico.js";

const [command, ...args] = process.argv.slice(2);
if (command !== "dorico") {
	console.error(USAGE);
	process.exit(2);
}
process.exit(
	await dorico(args, {
		url: ENV.MAC_BENCH_URL,
		token: ENV.MAC_BENCH_TOKEN,
		out: (s) => console.log(s),
		err: (s) => console.error(s),
		...(process.env.MAC_BENCH_CWD ? { cwd: process.env.MAC_BENCH_CWD } : {}),
	}),
);
