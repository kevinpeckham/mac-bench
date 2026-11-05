/**
 * One Remote Control connection to Dorico: the handshake (saving the token
 * Dorico issues), commands and their replies, statuses, and reconnecting
 * whenever Dorico quits and comes back.
 */
import { DoricoError, type Incoming, type Layout, type Status } from "./protocol.js";
import { loadToken, saveToken } from "./token.js";

export type ClientState = "not running" | "waiting for Allow in Dorico" | "connected";

export type ClientOptions = {
	url: string;
	tokenPath: string;
	clientName: string;
	/** How often to try again while Dorico isn't reachable. */
	retryMs?: number;
	/** How long a connect may go unanswered before we say Dorico is showing its Allow prompt. */
	allowWaitMs?: number;
};

type Waiter = {
	pred: (s: Status) => boolean;
	resolve: (s: Status) => void;
	reject: (e: Error) => void;
};
type Pending = { resolve: (m: Incoming) => void; reject: (e: Error) => void };

const REPLY_MS = 10_000;

export class DoricoClient {
	state: ClientState = "not running";
	version: { variant: string; number: string } | null = null;
	/**
	 * The highest project ID seen on this connection. Dorico's IDs only grow
	 * (two-projects.log), so a project newer than this is one just opened.
	 */
	highestScoreID = -1;
	private ws: WebSocket | null = null;
	private started = false;
	private retry: ReturnType<typeof setTimeout> | null = null;
	private allowTimer: ReturnType<typeof setTimeout> | null = null;
	/** Requests awaiting a reply other than a status, in the order sent. */
	private pending: Pending[] = [];
	private waiters = new Set<Waiter>();

	constructor(private readonly opts: ClientOptions) {}

	start(): void {
		this.started = true;
		this.connect();
	}

	stop(): void {
		this.started = false;
		if (this.retry) clearTimeout(this.retry);
		this.ws?.close();
		this.drop("stopped");
	}

	/** Run a command; resolves when Dorico accepts it (`kOK`), which is not when it has finished. */
	async command(command: string, timeoutMs = REPLY_MS): Promise<void> {
		const reply = await this.request({ message: "command", command }, timeoutMs);
		if (reply.code !== "kOK")
			throw new DoricoError(`${command}: ${String(reply.detail ?? reply.code)}`);
	}

	/** The full status (`getstatus`). */
	status(timeoutMs = REPLY_MS): Promise<Status> {
		this.ready();
		const full = this.waitForStatus((s) => "canUndo" in s, timeoutMs);
		this.send({ message: "getstatus" });
		return full;
	}

	async layouts(timeoutMs = REPLY_MS): Promise<Layout[]> {
		const reply = await this.request({ message: "getlayouts" }, timeoutMs);
		return (reply.layouts as Layout[] | undefined) ?? [];
	}

	/** The next status, pushed or asked for, that `pred` accepts. */
	waitForStatus(pred: (s: Status) => boolean, timeoutMs: number): Promise<Status> {
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				pred,
				resolve: (s) => {
					clearTimeout(timer);
					resolve(s);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new DoricoError(`no matching status from Dorico within ${timeoutMs} ms`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	/** Throws at once unless connected, so a job never waits on a Dorico that can't answer. */
	private ready(): void {
		if (this.state === "waiting for Allow in Dorico")
			throw new DoricoError("Dorico is waiting for someone to click Allow for mac-bench");
		if (this.state !== "connected") throw new DoricoError("Dorico is not running");
	}

	private async request(message: object, timeoutMs: number): Promise<Incoming> {
		this.ready();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = this.pending.filter((p) => p !== entry);
				reject(new DoricoError(`no reply from Dorico within ${timeoutMs} ms`));
				// Replies are matched in order: a late one would answer the next
				// request. Start afresh on a new connection instead.
				this.ws?.close();
			}, timeoutMs);
			const entry: Pending = {
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			this.pending.push(entry);
			this.send(message);
		});
	}

	private send(message: object): void {
		this.ws?.send(JSON.stringify(message));
	}

	private connect(): void {
		const ws = new WebSocket(this.opts.url);
		this.ws = ws;
		ws.onopen = () => {
			const token = loadToken(this.opts.tokenPath);
			this.send({
				message: "connect",
				clientName: this.opts.clientName,
				handshakeVersion: "1.0",
				...(token ? { sessionToken: token } : {}),
			});
			// Unanswered, the connect means Dorico is showing its Allow prompt.
			this.allowTimer = setTimeout(() => {
				if (this.state !== "connected") this.state = "waiting for Allow in Dorico";
			}, this.opts.allowWaitMs ?? 1500);
		};
		ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as Incoming);
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.drop("Dorico went away");
			if (this.started) this.retry = setTimeout(() => this.connect(), this.opts.retryMs ?? 3000);
		};
		ws.onerror = () => {}; // onclose follows and retries
	}

	/** Forget the connection: fail what was waiting on it. */
	private drop(reason: string): void {
		if (this.allowTimer) clearTimeout(this.allowTimer);
		this.state = "not running";
		this.version = null;
		this.highestScoreID = -1; // a restarted Dorico counts again
		for (const p of this.pending.splice(0)) p.reject(new DoricoError(reason));
		for (const w of this.waiters) w.reject(new DoricoError(reason));
		this.waiters.clear();
	}

	private receive(m: Incoming): void {
		if (m.message === "status") {
			const id = (m as Status).activeOpenScoreID;
			if (typeof id === "number" && id > this.highestScoreID) this.highestScoreID = id;
			for (const w of this.waiters)
				if (w.pred(m as Status)) {
					this.waiters.delete(w);
					w.resolve(m as Status);
				}
			return;
		}
		if (m.message === "sessiontoken") {
			saveToken(this.opts.tokenPath, String(m.sessionToken));
			this.send({ message: "acceptsessiontoken", sessionToken: m.sessionToken });
			return;
		}
		if (this.state !== "connected") {
			if (m.message === "response" && m.code === "kConnected") this.connected();
			return;
		}
		this.pending.shift()?.resolve(m);
	}

	private connected(): void {
		if (this.allowTimer) clearTimeout(this.allowTimer);
		this.state = "connected";
		this.request({ message: "getappinfo", info: "version" }, REPLY_MS).then(
			(v) => {
				this.version = { variant: String(v.variant), number: String(v.number) };
			},
			() => {},
		);
	}
}
