/**
 * The helper's HTTP API, on the Mac: `GET /health` and `POST /jobs`, each
 * needing the shared bearer token. Takes everything as arguments; `main.ts`
 * reads the environment.
 */
import { timingSafeEqual } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import type { DoricoClient } from "../dorico/client.js";
import type { JobFile, JobQueue } from "../dorico/job.js";

export type ServerOptions = {
	hostname: string;
	port: number;
	token: string;
	client: DoricoClient;
	queue: JobQueue;
	/** The largest request accepted (default 20 MB). */
	maxBytes?: number;
};

const MAX_BYTES = 20 * 1024 * 1024;

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
	const uploads = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
	if (uploads.length === 0)
		return json({ error: "no files: send each as a multipart field named file" }, 400);
	const files: JobFile[] = await Promise.all(
		uploads.map(async (f) => ({ name: f.name, xml: await f.text() })),
	);
	const results = await opts.queue.add(files);
	return json({
		results: results.map((r) => (r.ok ? { ...r, pdf: Buffer.from(r.pdf).toString("base64") } : r)),
	});
}

export function startServer(opts: ServerOptions): { url: string; stop(): void } {
	const maxBytes = opts.maxBytes ?? MAX_BYTES;
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
				});
			if (req.method === "POST" && pathname === "/jobs") return jobs(req, opts, maxBytes);
			return json({ error: "not found" }, 404);
		},
	});
	return { url: `http://${opts.hostname}:${server.port}`, stop: () => server.stop(true) };
}
