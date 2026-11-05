/**
 * A fake Dorico Remote Control server for tests, sending the messages the
 * recordings in tests/recordings/ show the real one sending (Elements
 * 6.2.31): the handshake, `kOK` and `kUnknownCommand`, full and pushed
 * statuses, `layoutslist`, and the PDF an export writes beside the file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";

type Project = { file: string; title: string; viewContainer: number };

export type FakeOptions = {
	/** The token Dorico knows; a connect with another token gets silence (its Allow prompt). */
	knownToken?: string;
	/** The token issued to a connect without one (as if Kevin clicked Allow). */
	issueToken?: string;
	/** How long an import takes before the project appears. */
	openDelayMs?: number;
	/** Whether an export writes its PDF (false: the export never appears). */
	writesPdf?: boolean;
	/** Whether `Window.SwitchToLayout` brings the project to the front. */
	honoursSwitch?: boolean;
	port?: number;
};

export class FakeDorico {
	readonly projects = new Map<number, Project>();
	active: number | null = null;
	readonly commandsReceived: string[] = [];
	/** Called right after an import adds its project (and its status is pushed). */
	onOpened: ((id: number) => void) | null = null;
	/** Every message sent to a client, in order. */
	readonly sent: Record<string, unknown>[] = [];
	private nextId = 35;
	private readonly server: Server<undefined>;
	private readonly clients = new Set<ServerWebSocket<undefined>>();
	private readonly opts: Required<Omit<FakeOptions, "port">>;

	constructor(options: FakeOptions = {}) {
		this.opts = {
			knownToken: "known-token",
			issueToken: "issued-token",
			openDelayMs: 20,
			writesPdf: true,
			honoursSwitch: true,
			...options,
		};
		this.server = Bun.serve({
			port: options.port ?? 0,
			hostname: "127.0.0.1",
			fetch: (req, server) =>
				server.upgrade(req) ? undefined : new Response("websocket only", { status: 400 }),
			websocket: {
				open: (ws) => {
					this.clients.add(ws);
				},
				close: (ws) => {
					this.clients.delete(ws);
				},
				message: (ws, data) => this.receive(ws, JSON.parse(String(data))),
			},
		});
	}

	get url(): string {
		return `ws://127.0.0.1:${this.server.port}`;
	}

	get port(): number {
		return this.server.port ?? 0;
	}

	/** Simulate Kevin clicking into another project. */
	focus(id: number | null): void {
		this.active = id;
		this.push(this.activeFields());
	}

	/** Add a project without a client (standing in for one of Kevin's). */
	openDirect(file: string): number {
		return this.add(file);
	}

	/** Simulate Dorico quitting. */
	kill(): void {
		this.server.stop(true);
	}

	stop(): void {
		this.server.stop(true);
	}

	private send(ws: ServerWebSocket<undefined>, m: Record<string, unknown>) {
		this.sent.push(m);
		ws.send(JSON.stringify(m));
	}

	private push(fields: Record<string, unknown>) {
		for (const ws of this.clients)
			this.send(ws, { message: "status", ...fields, selectedEventType: "kNone" });
	}

	private activeFields(): Record<string, unknown> {
		const p = this.active === null ? undefined : this.projects.get(this.active);
		return p
			? {
					activeOpenScoreID: this.active,
					activeViewContainerID: p.viewContainer,
					hasScore: true,
				}
			: { hasScore: this.projects.size > 0 };
	}

	private fullStatus(): Record<string, unknown> {
		return {
			message: "status",
			...this.activeFields(),
			canUndo: false,
			hasSelection: false,
			noteInputMode: "kOverwrite",
			windowMode: "kWriteMode",
		};
	}

	private add(file: string): number {
		const id = this.nextId++;
		const xml = existsSync(file) ? readFileSync(file, "utf8") : "";
		const title = /<work-title>([^<]*)<\/work-title>/.exec(xml)?.[1] ?? "Untitled";
		this.projects.set(id, { file, title, viewContainer: id - 1 });
		this.active = id;
		return id;
	}

	private receive(ws: ServerWebSocket<undefined>, m: Record<string, unknown>) {
		switch (m.message) {
			case "connect":
				if (m.sessionToken === undefined) {
					this.send(ws, { message: "sessiontoken", sessionToken: this.opts.issueToken });
				} else if (m.sessionToken === this.opts.knownToken) {
					this.send(ws, { message: "response", code: "kConnected" });
					this.send(ws, this.fullStatus());
				}
				return; // an unknown token: silence (Dorico shows its Allow prompt)
			case "acceptsessiontoken":
				if (m.sessionToken === this.opts.issueToken) {
					this.opts.knownToken = this.opts.issueToken;
					this.send(ws, { message: "response", code: "kConnected" });
				}
				return;
			case "getstatus":
				return this.send(ws, this.fullStatus());
			case "getappinfo":
				this.push(this.activeFields());
				return this.send(ws, { message: "version", variant: "Elements", number: "6.2.31" });
			case "getlayouts":
				return this.send(ws, {
					message: "layoutslist",
					openScoreID: this.active,
					layouts: [
						{
							layoutID: 0,
							layoutName: "Full score",
							layoutNumber: 1,
							layoutType: "kFullScoreLayout",
						},
					],
				});
			case "command":
				return this.command(ws, String(m.command));
		}
	}

	private command(ws: ServerWebSocket<undefined>, command: string) {
		this.commandsReceived.push(command);
		const [name, query = ""] = command.split(/\?(.*)/s);
		const params = new Map(
			query
				.split("&")
				.filter(Boolean)
				.map((kv) => kv.split(/=(.*)/s) as [string, string]),
		);
		const ok = () => this.send(ws, { message: "response", code: "kOK" });
		switch (name) {
			case "File.Open": {
				ok();
				const file = params.get("File") ?? "";
				setTimeout(() => {
					const id = this.add(file);
					this.push(this.activeFields());
					this.onOpened?.(id);
				}, this.opts.openDelayMs);
				return;
			}
			case "Print.ExportCurrentLayoutAsPDF": {
				ok();
				const p = this.active === null ? undefined : this.projects.get(this.active);
				const pdf = p && join(dirname(p.file), `01 - Full score - ${p.title}.pdf`);
				if (pdf && this.opts.writesPdf && !existsSync(pdf))
					writeFileSync(pdf, `%PDF-1.4\n% fake export of ${p.title}\n`);
				return;
			}
			case "File.CloseProject": {
				ok();
				const id = Number(params.get("OpenScoreID") ?? this.active);
				const closed = this.projects.get(id);
				this.projects.delete(id);
				if (this.active === id) this.active = [...this.projects.keys()].at(-1) ?? null;
				this.push({
					activeOpenScoreID: id,
					activeViewContainerID: closed?.viewContainer,
					hasScore: this.projects.size > 0,
				});
				return;
			}
			case "Window.SwitchToLayout": {
				ok();
				const id = Number(params.get("OpenScoreID"));
				if (this.opts.honoursSwitch && this.projects.has(id)) this.focus(id);
				return;
			}
			default:
				this.send(ws, { message: "response", code: "kError", detail: "kUnknownCommand" });
		}
	}
}
