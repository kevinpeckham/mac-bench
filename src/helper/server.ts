/**
 * The helper's HTTP API, on the Mac: `GET /health` and `POST /jobs`, each
 * needing the shared bearer token. Takes everything as arguments; `main.ts`
 * reads the environment. A job is PDFs by default; a multipart field
 * `export` of `musicxml` or `mxl` makes it a MusicXML export job instead,
 * and `import` of `midi` a MIDI job: its files are Standard MIDI Files,
 * read as bytes (multipart carries them as they are), exported as MusicXML
 * unless `export` says `mxl`.
 */
import { timingSafeEqual } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import type { AxClient } from "../ax/client.js";
import type { DoricoClient } from "../dorico/client.js";
import { EXPORT_FORMATS, type ExportFormat } from "../dorico/export.js";
import type { JobQueue, JobResult, QueueFile } from "../dorico/job.js";

export type ServerOptions = {
	hostname: string;
	port: number;
	token: string;
	client: DoricoClient;
	queue: JobQueue;
	/** MacBenchAX, for /health's `ax.trusted`. */
	ax: AxClient;
	/** How long /health keeps `ax.trusted` (default 30 s). */
	axCacheMs?: number;
	/** The largest request accepted (default 20 MB). */
	maxBytes?: number;
};

/** The largest request the helper accepts by default; the CLI checks against it too. */
export const MAX_BYTES = 20 * 1024 * 1024;

function authorised(req: Request, token: string): boolean {
	const given = Buffer.from(req.headers.get("authorization") ?? "");
	const wanted = Buffer.from(`Bearer ${token}`);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function jobs(req: Request, opts: ServerOptions, maxBytes: number): Promise<Response> {
	if (Number(req.headers.get("content-length") ?? 0) > maxBytes)
		return json({ error: `larger than ${maxBytes} bytes` }, 413);
	const form = await req.formData().catch(() => null);
	const format = form?.get("export") ?? null;
	if (format !== null && !EXPORT_FORMATS.includes(format as ExportFormat))
		return json(
			{ error: `export must be ${EXPORT_FORMATS.join(" or ")} (or absent, for PDFs)` },
			400,
		);
	const kind = form?.get("import") ?? null;
	if (kind !== null && kind !== "midi")
		return json({ error: "import must be midi (or absent, for MusicXML)" }, 400);
	const uploads = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
	if (uploads.length === 0)
		return json({ error: "no files: send each as a multipart field named file" }, 400);
	const files: QueueFile[] = await Promise.all(
		uploads.map(async (f) =>
			kind === "midi"
				? { name: f.name, midi: new Uint8Array(await f.arrayBuffer()) }
				: { name: f.name, xml: await f.text() },
		),
	);
	const results = await opts.queue.add(files, (format as ExportFormat | null) ?? undefined);
	return json({ results: results.map(wire) });
}

/** A result as sent: the PDF or exported file base64. */
const wire = (r: JobResult) => {
	if (!r.ok) return r;
	if ("pdf" in r) return { ...r, pdf: Buffer.from(r.pdf).toString("base64") };
	return { ...r, file: Buffer.from(r.file).toString("base64") };
};

/**
 * Whether MacBenchAX is granted Accessibility; no answer counts as no.
 * Asked at most once per `ms`: each ask launches the app (and a missing one
 * takes the client's whole time limit).
 */
function axTrusted(ax: AxClient, ms: number): () => Promise<boolean> {
	let last: { at: number; trusted: Promise<boolean> } | null = null;
	return () => {
		if (!last || Date.now() - last.at > ms)
			last = {
				at: Date.now(),
				trusted: ax.run(["trusted"]).then(
					(r) => r.trusted === true,
					() => false,
				),
			};
		return last.trusted;
	};
}

export function startServer(opts: ServerOptions): { url: string; stop(): void } {
	const maxBytes = opts.maxBytes ?? MAX_BYTES;
	const trusted = axTrusted(opts.ax, opts.axCacheMs ?? 30_000);
	const server = Bun.serve({
		hostname: opts.hostname,
		port: opts.port,
		maxRequestBodySize: maxBytes,
		idleTimeout: 0, // a job can take minutes
		fetch: async (req) => {
			if (!authorised(req, opts.token))
				return json({ error: "missing or wrong bearer token" }, 401);
			const { pathname } = new URL(req.url);
			if (req.method === "GET" && pathname === "/health")
				return json({
					helper: pkg.version,
					dorico: opts.client.state,
					variant: opts.client.version?.variant ?? null,
					version: opts.client.version?.number ?? null,
					queue: opts.queue.length,
					ax: { trusted: await trusted() },
				});
			if (req.method === "POST" && pathname === "/jobs") return jobs(req, opts, maxBytes);
			return json({ error: "not found" }, 404);
		},
	});
	return { url: `http://${opts.hostname}:${server.port}`, stop: () => server.stop(true) };
}
