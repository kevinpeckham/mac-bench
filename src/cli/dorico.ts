/**
 * `mac-bench dorico [--midi] [--export musicxml|mxl] <file…> [--out <dir>]`
 * and `--health`, on the VM: send MusicXML to the helper on the Mac, write
 * back the PDFs Dorico engraved, or with `--export` the MusicXML (or .mxl)
 * Dorico exported, as `<input base>.dorico.musicxml` / `.dorico.mxl`. With
 * `--midi` the files are Standard MIDI Files, which Dorico imports and
 * exports (as MusicXML unless `--export mxl`); what its MIDI Import Options
 * window showed is written beside each as `<base>.midi-import.json`. Takes
 * its config and output as arguments (`main.ts` reads the env).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isMidi } from "../dorico/midi.js";
import { MAX_BYTES } from "../helper/server.js";

export type DoricoIo = {
	url: string;
	token: string;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Where relative paths start (the caller's folder). */
	cwd?: string;
	fetch?: typeof fetch;
};

type Result =
	| { name: string; ok: true; pdf?: string; file?: string; importWindow?: unknown }
	| { name: string; ok: false; step: string; message: string; importWindow?: unknown };

export const USAGE =
	"usage: mac-bench dorico [--export musicxml|mxl] <file.musicxml…> [--out <dir>] | --midi [--export musicxml|mxl] <file.mid…> [--out <dir>] | --health";

const FORMATS = ["musicxml", "mxl"];

/** `20261105-170412`, for the default run folder. */
const stamp = (d = new Date()) =>
	d
		.toISOString()
		.replace(/\D/g, "")
		.replace(/^(\d{8})(\d{6}).*/, "$1-$2");

/** Call the helper; null after printing why it couldn't be reached or refused. */
async function call(io: DoricoIo, path: string, init: RequestInit = {}): Promise<Response | null> {
	const res = await (io.fetch ?? fetch)(`${io.url}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${io.token}` },
	}).catch((e: Error) => {
		io.err(`can't reach the helper at ${io.url} (MAC_BENCH_URL): ${e.message}`);
		return null;
	});
	if (res?.status === 401) {
		io.err("the helper refused the token: check MAC_BENCH_TOKEN on both machines");
		return null;
	}
	if (res && !res.ok) {
		io.err(`the helper answered ${res.status}: ${await res.text()}`);
		return null;
	}
	return res;
}

/** `<name's stem><ext>` in `dir`, numbered if a file of that name is already taken. */
function outPath(dir: string, name: string, ext: string, taken: Set<string>): string {
	const stem = basename(name).replace(/\.(musicxml|xml|mxl|midi?)$/i, "");
	let path = join(dir, `${stem}${ext}`);
	for (let n = 2; taken.has(path); n++) path = join(dir, `${stem}-${n}${ext}`);
	taken.add(path);
	return path;
}

/** The value after `flag`, the files, and whether a flag lacked its value. */
function parse(args: string[]) {
	const values = new Map<string, string | undefined>();
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === "--out" || a === "--export") values.set(a, args[++i]);
		else if (!a.startsWith("--")) files.push(a);
	}
	return {
		out: values.get("--out"),
		format: values.get("--export"),
		hasFormat: values.has("--export"),
		midi: args.includes("--midi"),
		files,
	};
}

export async function dorico(args: string[], io: DoricoIo): Promise<number> {
	const cwd = io.cwd ?? process.cwd();
	if (args.includes("--health")) {
		const res = await call(io, "/health");
		if (!res) return 1;
		io.out(JSON.stringify(await res.json(), null, 2));
		return 0;
	}
	const { out, format: given, hasFormat, midi, files } = parse(args);
	const format = given ?? (midi ? "musicxml" : undefined);
	const outDir = resolve(cwd, out ?? join("dorico-runs", stamp()));
	if (files.length === 0 || (hasFormat && !FORMATS.includes(format ?? ""))) {
		io.err(USAGE);
		return 2;
	}
	const missing = files.filter((f) => !existsSync(resolve(cwd, f)));
	if (missing.length) {
		io.err(`no such file: ${missing.join(", ")}`);
		return 1;
	}
	const bytes = files.map((f) => new Uint8Array(readFileSync(resolve(cwd, f))));
	if (midi) {
		const notMidi = files.filter((_, i) => !isMidi(bytes[i] ?? new Uint8Array()));
		if (notMidi.length) {
			io.err(
				`not a Standard MIDI File (no MThd header): ${notMidi.map((f) => basename(f)).join(", ")}`,
			);
			return 1;
		}
	}
	const size = bytes.reduce((n, b) => n + b.length, 0);
	if (size > MAX_BYTES) {
		io.err(`the files come to ${size} bytes, larger than the helper takes (${MAX_BYTES})`);
		return 1;
	}
	const form = new FormData();
	files.forEach((f, i) => {
		form.append("file", new File([bytes[i] ?? new Uint8Array()], basename(f)));
	});
	if (midi) form.append("import", "midi");
	if (format) form.append("export", format);
	const ext = format ? `.dorico.${format}` : ".pdf";
	const res = await call(io, "/jobs", { method: "POST", body: form });
	if (!res) return 1;
	const { results } = (await res.json()) as { results: Result[] };
	mkdirSync(outDir, { recursive: true });
	const taken = new Set<string>();
	for (const r of results) {
		const path = outPath(outDir, r.name, ext, taken);
		if (r.ok) {
			writeFileSync(path, Buffer.from((format ? r.file : r.pdf) ?? "", "base64"));
			io.out(`ok ${path}`);
		} else io.out(`FAIL ${r.name}: ${r.step}: ${r.message}`);
		if (r.importWindow !== undefined) {
			const json = `${path.slice(0, -ext.length)}.midi-import.json`;
			writeFileSync(json, `${JSON.stringify(r.importWindow, null, 2)}\n`);
			io.out(`import ${json}`);
		}
	}
	return results.every((r) => r.ok) ? 0 : 1;
}
