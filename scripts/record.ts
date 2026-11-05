#!/usr/bin/env bun
/**
 * Record what Dorico says over Remote Control, for the fake Dorico the tests
 * use. Run on the Mac, with Dorico open and the helper's token saved:
 *
 *   bun scripts/record.ts <file.musicxml> [name]
 *
 * Opens the file in a fresh folder, asks for flows and layouts, sends an
 * unknown command, exports the PDF, closes by ID without saving, then tries
 * an unknown token (Dorico stays silent and shows an Allow prompt: click
 * Deny). Writes tests/recordings/<name>.log (default "probe") with session
 * tokens replaced by <token>.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const [file, name = "probe"] = process.argv.slice(2);
if (!file) {
	console.error("usage: bun scripts/record.ts <file.musicxml> [name]");
	process.exit(2);
}
const TOKEN = join(homedir(), "Library/Application Support/mac-bench/dorico-token");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const lines: string[] = [];
const t0 = Date.now();
const out = (label: string, data: unknown) => {
	const line = `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} ${label} ${JSON.stringify(data)}`;
	lines.push(line.replace(UUID, "<token>"));
	console.log(line.replace(UUID, "<token>").slice(0, 200));
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
await new Promise((r) => {
	ws.onopen = r;
});
const token = readFileSync(TOKEN, "utf8").trim();
send({ message: "connect", clientName: "mac-bench", handshakeVersion: "1.0", sessionToken: token });
await sleep(1000);
send({ message: "getstatus" });
await sleep(1000);

const dir = join(homedir(), "Library/Application Support/mac-bench/record", String(Date.now()));
mkdirSync(dir, { recursive: true });
const copy = join(dir, basename(file));
copyFileSync(resolve(file), copy);
send({ message: "command", command: `File.Open?File=${copy}` });
await sleep(6000);
send({ message: "getstatus" });
await sleep(1000);
for (const m of ["getflows", "getlayouts"]) {
	send({ message: m });
	await sleep(1500);
}
send({ message: "command", command: "Foo.Bar" });
await sleep(1000);
send({ message: "command", command: "Print.ExportCurrentLayoutAsPDF" });
for (let i = 0; i < 30 && !readdirSync(dir).some((f) => f.endsWith(".pdf")); i++) await sleep(500);
out("pdf", readdirSync(dir));
const id = [...seen].reverse().find((m) => m.activeOpenScoreID)?.activeOpenScoreID;
send({ message: "command", command: `File.CloseProject?OpenScoreID=${id}&Save=false` });
await sleep(3000);
send({ message: "getstatus" });
await sleep(1500);
send({ message: "disconnect" });
await sleep(300);

const bad = new WebSocket("ws://127.0.0.1:4560");
bad.onmessage = (e) => out("bad<-", JSON.parse(String(e.data)));
await new Promise((r) => {
	bad.onopen = r;
});
bad.send(
	JSON.stringify({
		message: "connect",
		clientName: "mac-bench-record",
		handshakeVersion: "1.0",
		sessionToken: "00000000-0000-0000-0000-000000000000",
	}),
);
await sleep(4000);
out("bad token", "no reply within 4 s means Dorico is showing an Allow prompt: click Deny");
bad.close();
const target = join(import.meta.dir, "..", "tests/recordings", `${name}.log`);
writeFileSync(target, `${lines.join("\n")}\n`);
console.log(`\nWrote ${target}`);
process.exit(0);
