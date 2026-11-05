/** The recordings are public: they must never carry a Dorico session token. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "recordings");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test("no recording contains a session token", () => {
	const logs = readdirSync(DIR).filter((f) => f.endsWith(".log"));
	expect(logs.length).toBeGreaterThan(0);
	for (const log of logs) expect(readFileSync(join(DIR, log), "utf8")).not.toMatch(UUID);
});
