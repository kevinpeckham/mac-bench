#!/usr/bin/env bun
/**
 * Record how Dorico behaves with two projects open (both opened here, so
 * nothing of anyone else's is touched): what an open pushes while another
 * project is open, whether IDs only grow, SwitchToLayout, and closing by ID
 * while the other project is in front.
 *
 *   bun scripts/record-two.ts <file.musicxml> [name]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const [file, name = "two-projects"] = process.argv.slice(2);
if (!file) {
	console.error("usage: bun scripts/record-two.ts <file.musicxml> [name]");
	process.exit(2);
}
const WORK = join(homedir(), "Library/Application Support/mac-bench");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const lines: string[] = [];
const t0 = Date.now();
const out = (label: string, data: unknown) => {
	const line =
		`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} ${label} ${JSON.stringify(data)}`.replace(
			UUID,
			"<token>",
		);
	lines.push(line);
	console.log(line.slice(0, 240));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket("ws://127.0.0.1:4560");
const seen: Record<string, unknown>[] = [];
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	seen.push(m);
	out("<-", m);
};
const send = (m: object) => {
	out("->", m);
	ws.send(JSON.stringify(m));
};
const command = (c: string) => send({ message: "command", command: c });
const lastActive = () => {
	const s = [...seen]
		.reverse()
		.find((m) => m.message === "status" && m.activeOpenScoreID !== undefined);
	return { id: s?.activeOpenScoreID as number, view: s?.activeViewContainerID as number };
};
await new Promise((r) => {
	ws.onopen = r;
});
send({
	message: "connect",
	clientName: "mac-bench",
	handshakeVersion: "1.0",
	sessionToken: readFileSync(join(WORK, "dorico-token"), "utf8").trim(),
});
await sleep(1000);
const open = async (tag: string) => {
	const dir = join(WORK, "record", `${Date.now()}-${tag}`);
	mkdirSync(dir, { recursive: true });
	const copy = join(dir, basename(file));
	copyFileSync(resolve(file), copy);
	out("note", `open ${tag}`);
	command(`File.Open?File=${copy}`);
	await sleep(6000);
	send({ message: "getstatus" });
	await sleep(1000);
	return lastActive();
};
const p = await open("P");
const q = await open("Q (P already open)");
out("note", { P: p, Q: q });
out("note", "switch to P while Q is in front");
command(
	`Window.SwitchToLayout?OpenScoreID=${p.id}&ScoreLayoutViewContainerID=${p.view}&LayoutID=0`,
);
await sleep(2000);
send({ message: "getstatus" });
await sleep(1000);
out("note", "close Q by ID while P is in front");
command(`File.CloseProject?OpenScoreID=${q.id}&Save=false`);
await sleep(3000);
send({ message: "getstatus" });
await sleep(1000);
out("note", "is Q gone? switch to Q");
command(
	`Window.SwitchToLayout?OpenScoreID=${q.id}&ScoreLayoutViewContainerID=${q.view}&LayoutID=0`,
);
await sleep(2000);
send({ message: "getstatus" });
await sleep(1000);
out("note", "close P (whichever is left of ours)");
command(`File.CloseProject?OpenScoreID=${p.id}&Save=false`);
await sleep(3000);
command(`File.CloseProject?OpenScoreID=${q.id}&Save=false`);
await sleep(3000);
send({ message: "getstatus" });
await sleep(1000);
send({ message: "disconnect" });
await sleep(300);
const target = join(import.meta.dir, "..", "tests/recordings", `${name}.log`);
writeFileSync(target, `${lines.join("\n")}\n`);
console.log(`\nWrote ${target}`);
process.exit(0);
