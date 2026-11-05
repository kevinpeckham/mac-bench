/**
 * `mac-bench dorico <file.musicxml…> [--out <dir>]` and `--health`, on the
 * VM: send MusicXML to the helper on the Mac, write back the PDFs Dorico
 * engraved. Takes its config and output as arguments (`main.ts` reads the env).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
	| { name: string; ok: true; pdf: string }
	| { name: string; ok: false; step: string; message: string };

const USAGE = "usage: mac-bench dorico <file.musicxml…> [--out <dir>] | --health";

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

/** `name.pdf` in `dir`, numbered if a file of that name is already taken. */
function pdfPath(dir: string, name: string, taken: Set<string>): string {
	const stem = basename(name).replace(/\.(musicxml|xml|mxl)$/i, "");
	let path = join(dir, `${stem}.pdf`);
	for (let n = 2; taken.has(path); n++) path = join(dir, `${stem}-${n}.pdf`);
	taken.add(path);
	return path;
}

export async function dorico(args: string[], io: DoricoIo): Promise<number> {
	const cwd = io.cwd ?? process.cwd();
	if (args.includes("--health")) {
		const res = await call(io, "/health");
		if (!res) return 1;
		io.out(JSON.stringify(await res.json(), null, 2));
		return 0;
	}
	const at = args.indexOf("--out");
	const outDir = resolve(cwd, at >= 0 ? (args[at + 1] ?? "") : join("dorico-runs", stamp()));
	const files = args.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
	if (files.length === 0) {
		io.err(USAGE);
		return 2;
	}
	const missing = files.filter((f) => !existsSync(resolve(cwd, f)));
	if (missing.length) {
		io.err(`no such file: ${missing.join(", ")}`);
		return 1;
	}
	const form = new FormData();
	for (const f of files)
		form.append("file", new File([readFileSync(resolve(cwd, f))], basename(f)));
	const res = await call(io, "/jobs", { method: "POST", body: form });
	if (!res) return 1;
	const { results } = (await res.json()) as { results: Result[] };
	mkdirSync(outDir, { recursive: true });
	const taken = new Set<string>();
	for (const r of results) {
		if (!r.ok) {
			io.out(`FAIL ${r.name}: ${r.step}: ${r.message}`);
			continue;
		}
		const path = pdfPath(outDir, r.name, taken);
		writeFileSync(path, Buffer.from(r.pdf, "base64"));
		io.out(`ok ${path}`);
	}
	return results.every((r) => r.ok) ? 0 : 1;
}
