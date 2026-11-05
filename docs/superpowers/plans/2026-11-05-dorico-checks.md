# Dorico Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the bench VM, `bun run mac-bench dorico <file.musicxml…>` returns the PDF Dorico engraves from each file, made on a Mac with no one there.

**Architecture:** A Bun helper on the Mac (launchd user agent) holds one Dorico Remote Control WebSocket and serves `GET /health` and `POST /jobs` on the Mac's tailnet address, bearer-token protected. Jobs run one at a time: fresh folder, `File.Open`, focus check, `Print.ExportCurrentLayoutAsPDF`, wait for the PDF, `File.CloseProject?OpenScoreID=…&Save=false`. A CLI on the VM posts files and writes the PDFs.

**Tech Stack:** Bun 1.4, TypeScript strict, Biome (tabs), varlock with `@varlock/1password-plugin`, `bun test`. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-dorico-checks-design.md`

## Global Constraints

- Dorico Elements 6.2.31; nothing Pro-only. Remote Control on `ws://127.0.0.1:4560`, `handshakeVersion: "1.0"`, `clientName: "mac-bench"`.
- One job at a time; a fresh empty folder per file; never save a project; close only projects the helper opened, by `OpenScoreID`.
- Never read outside the helper's work directory (`~/Library/Application Support/mac-bench`); no broad `find`/Spotlight searches.
- Helper listens on the Mac's tailnet IPv4 only (100.64.0.0/10), port 7420; every request needs `Authorization: Bearer $MAC_BENCH_TOKEN`.
- Secrets only through varlock: `.env.schema` committed, `.env.local` holds only `OP_ENV_ID`, `OP_TOKEN`; the 1Password environment holds `MAC_BENCH_TOKEN`. Code reads `import { ENV } from "varlock/env"` only in the two entry points; everything below them takes config as arguments (so tests need no env).
- `MAC_BENCH_URL` default `http://kevins-macbook-pro-2021:7420`.
- Conventional commits, no Co-Authored-By or AI trailer. CHANGELOG `[Unreleased]` entry per user-visible change; FINDINGS.md entry per surprise (Kevin's convention).
- The Dorico session token is a secret: never committed (recordings have it replaced by `<token>`), stored mode 600.

## Facts from the spikes and probe (2026-11-05, Kevin's Mac)

Recorded in `tests/recordings/` (Task 1). The fake Dorico must reproduce these shapes exactly:

- Handshake with a known token: `-> {"message":"connect",…,"sessionToken":T}` `<- {"message":"response","code":"kConnected"}` then a full status. First time (no token): `<- {"message":"sessiontoken","sessionToken":T}` after Kevin clicks Allow; answer `{"message":"acceptsessiontoken","sessionToken":T}` → `kConnected`. **Unknown token: no reply at all** (Dorico shows an Allow prompt).
- Command: `<- {"message":"response","code":"kOK"}` (accepted, not finished); unknown: `{"message":"response","code":"kError","detail":"kUnknownCommand"}`.
- Status: full (`getstatus`, has `canUndo`) or partial pushes; `activeOpenScoreID` and `activeViewContainerID` present while a project is active, `hasScore` boolean. After `File.Open`, ~2 s later a push with the new `activeOpenScoreID` and `hasScore:true`. After `File.CloseProject?OpenScoreID=35&Save=false`: a push `{"activeOpenScoreID":35,…,"hasScore":false}` (stale id!) and the next `getstatus` has no `activeOpenScoreID`.
- `{"message":"getlayouts"}` → `{"message":"layoutslist","openScoreID":35,"layouts":[{"layoutID":0,"layoutName":"Full score","layoutNumber":1,"layoutType":"kFullScoreLayout"},…]}`.
- Export writes `01 - Full score - <title>.pdf` beside the opened file within ~0.3 s; if it exists, a modal dialog blocks.

## Review Focus

1. Kevin clicks into his own project mid-job: the job must not export or close his project (Task 3 test `focus moved to another project`).
2. Dorico quits or restarts between or during jobs: the job fails naming the step, the helper reconnects with its token, `/health` says so (Task 2 `reconnects`, Task 3 `Dorico goes away mid-job`).
3. Saved token no longer known to Dorico: Dorico silently prompts; `/health` must say "waiting for Allow in Dorico" and jobs fail fast instead of hanging (Task 2 `unknown token`).
4. Two `POST /jobs` at once: they run one after the other, never interleaved (Task 4 `concurrent jobs queue`).
5. A file that isn't MusicXML, or is huge: rejected before Dorico sees it, so no import-error dialog (Task 3 `rejects non-MusicXML`; Task 4 `413`).

---

### Task 1: Scaffold, environment, recordings

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.env.schema`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `FINDINGS.md`, `scripts/record.ts`, `tests/recordings/{spike1,spike2,probe}.log`, `tests/recordings.test.ts`

- [ ] **Step 1:** `package.json` (`"name": "mac-bench"`, private, `"type": "module"`), devDependencies `@biomejs/biome`, `@types/bun`, `typescript` (versions as barmark's), dependencies `varlock`, `@varlock/1password-plugin`. Scripts: `"test": "bun test"`, `"check": "biome check . && tsc"`, `"helper": "varlock run -- bun src/helper/main.ts"`, `"mac-bench": "varlock run -- bun src/cli/main.ts"`. `tsconfig.json`, `biome.json`: barmark's, minus its paths/overrides, `include: ["src", "tests", "scripts"]`.
- [ ] **Step 2:** `.env.schema`, barmark's 1Password header (`@plugin(@varlock/1password-plugin)`, `@initOp(token=$OP_TOKEN, allowAppAuth=false)`, `@setValuesBulk(opLoadEnvironment($OP_ENV_ID))`), items `OP_TOKEN` (`@required @type=opServiceAccountToken`), `OP_ENV_ID` (`@required @sensitive=false`), `MAC_BENCH_TOKEN` (`@required`), `MAC_BENCH_URL` (`@sensitive=false`, default above), `MAC_BENCH_PORT` (`@sensitive=false`, default `7420`).
- [ ] **Step 3:** Run `bunx varlock load` on the VM. Expected: `MAC_BENCH_TOKEN` shown as set (sensitive, redacted). If it fails, stop and tell Kevin (his 1Password setup).
- [ ] **Step 4:** Copy the three logs into `tests/recordings/`, replacing every session token value with `<token>`; commit `scripts/record.ts` (the probe from this session, `clientName: "mac-bench-record"`, writing to `tests/recordings/<name>.log`). Test `tests/recordings.test.ts`: `no recording contains a session token` — no file matches `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/`.
- [ ] **Step 5:** `CLAUDE.md` (what the repo is, layout, commands, the Global Constraints above, SSH line for the Mac), `README.md` (spec's "Setting up a Mac" checklist, filled in by Task 5), `CHANGELOG.md` `[Unreleased]`, `FINDINGS.md` with the spike findings (`File.Save?File=` opens a dialog; export folder = opened file's folder; unknown token is silent; stale id in the close push).
- [ ] **Step 6:** `bun install && bun test && bun run check` all pass. Commit `chore: scaffold mac-bench`.

### Task 2: Remote Control client and fake Dorico

**Files:**
- Create: `src/dorico/protocol.ts`, `src/dorico/token.ts`, `src/dorico/client.ts`, `tests/fake-dorico.ts`, `tests/client.test.ts`

**Interfaces:**
- Produces:
  - `type Status = { hasScore?: boolean; activeOpenScoreID?: number; activeViewContainerID?: number; [k: string]: unknown }`
  - `type Layout = { layoutID: number; layoutName: string; layoutType: string }`
  - `class DoricoError extends Error { step: string }`
  - `loadToken(path): string | null`, `saveToken(path, token): void` (mode 0o600)
  - `type ClientState = "not running" | "waiting for Allow in Dorico" | "connected"`
  - `class DoricoClient { constructor(opts: { url: string; tokenPath: string; clientName: string; retryMs?: number }); start(): void; stop(): void; state: ClientState; version: { variant: string; number: string } | null; command(c: string, timeoutMs?: number): Promise<void> /* throws DoricoError on kError or timeout */; status(timeoutMs?: number): Promise<Status> /* full getstatus */; layouts(timeoutMs?: number): Promise<Layout[]>; waitForStatus(pred: (s: Status) => boolean, timeoutMs: number): Promise<Status> /* resolves on any status, pushed or asked, matching pred */ }`
  - Fake: `class FakeDorico { constructor(opts?: { knownToken?: string; openDelayMs?: number }); url: string; stop(): void; projects: Map<number, { file: string; title: string }>; active: number | null; focus(id: number | null): void /* simulate Kevin clicking */; kill(): void /* simulate quit */; commandsReceived: string[] }` — reproduces the recorded handshake, `File.Open` (adds project after `openDelayMs`, pushes status), `Print.ExportCurrentLayoutAsPDF` (writes `01 - Full score - <title>.pdf` beside the active project's file, title from `<work-title>`), `File.CloseProject?OpenScoreID=&Save=false` (removes it, pushes the stale-id `hasScore:false` status), `Window.SwitchToLayout?OpenScoreID=…` (makes it active), `getstatus`, `getlayouts`, `getappinfo` (`Elements`, `6.2.31`), unknown → `kUnknownCommand`; unknown token → silence.

- [ ] **Step 1: tests** in `tests/client.test.ts`, each against a `FakeDorico`:
  - `connects with a saved token` → `state === "connected"`, `version` `{variant:"Elements", number:"6.2.31"}`.
  - `first connect saves the token Dorico issues` (fake issues `sessiontoken` when no token is sent) → file exists, mode `0o600`, content the token.
  - `unknown token` → within 2 s `state === "waiting for Allow in Dorico"`; `command()` rejects at once with `DoricoError` whose message contains `Allow`.
  - `not running` (no fake listening) → `state === "not running"`; `command()` rejects at once.
  - `reconnects` → `kill()`, then a new fake on the same port; within `retryMs*3` state is `connected` again.
  - `unknown command rejects with kUnknownCommand`.
  - `waitForStatus sees pushed statuses` → after `command("File.Open?File=…")`, `waitForStatus(s => s.activeOpenScoreID !== undefined && s.hasScore === true, 5000)` returns the new id.
  - `fake matches the recordings` → every message shape the fake sends for handshake, `kOK`, `kUnknownCommand`, `layoutslist` has the same keys as the corresponding line in `tests/recordings/probe.log`.
- [ ] **Step 2:** `bun test tests/client.test.ts` → FAIL (modules missing).
- [ ] **Step 3:** Implement. Replies are matched in order: a `command`, `getlayouts` or `getappinfo` awaits the next non-`status` message; `status` messages go to `waitForStatus` waiters and to `status()` (full status = has `canUndo`). Retry the connection every `retryMs` (default 3000) while started.
- [ ] **Step 4:** `bun test` → PASS; `bun run check` passes. Commit `feat: Dorico Remote Control client`.

### Task 3: Job runner

**Files:**
- Create: `src/dorico/job.ts`, `tests/job.test.ts`

**Interfaces:**
- Consumes: `DoricoClient`, `DoricoError`, `Status`, `Layout` (Task 2).
- Produces:
  - `type FileResult = { name: string; ok: true; pdf: Uint8Array } | { name: string; ok: false; step: "check" | "open" | "focus" | "export" | "close"; message: string }`
  - `type Timeouts = { openMs: number; exportMs: number; closeMs: number }` with `DEFAULT_TIMEOUTS = { openMs: 30_000, exportMs: 60_000, closeMs: 15_000 }`
  - `runFile(client: DoricoClient, file: { name: string; xml: string }, workDir: string, timeouts?: Timeouts): Promise<FileResult>`
  - `class JobQueue { constructor(run: (files: {name:string;xml:string}[]) => Promise<FileResult[]>); add(files): Promise<FileResult[]>; length: number }`
  - `pruneJobs(workDir: string, olderThanMs: number): void`

- [ ] **Step 1: tests** in `tests/job.test.ts` with `FakeDorico` and a temp work dir:
  - `exports a PDF and closes the project` → `ok`, `pdf` starts with `%PDF` (fake writes `%PDF-1.4…`), fake has no projects, job folder deleted.
  - `rejects non-MusicXML` (`xml: "hello"`) → `ok:false, step:"check"`; fake received no command.
  - `open timeout` (`openDelayMs` > `openMs`) → `step:"open"`.
  - `focus moved to another project`: after open, `fake.focus(otherId)` (a project the test opened first, standing in for Kevin's) → runner sends `Window.SwitchToLayout?OpenScoreID=<job>&ScoreLayoutViewContainerID=<vc>&LayoutID=0`, exports the job's project; Kevin's project is still open and has no PDF beside it.
  - `focus can't be restored` (fake ignores SwitchToLayout) → `step:"focus"`; the export command was never sent; the job's project is closed; Kevin's still open.
  - `export timeout` (fake writes no PDF) → `step:"export"`, project closed, job folder kept.
  - `Dorico goes away mid-job` (`kill()` after open) → `ok:false`, step named, no throw.
  - `queue runs jobs one at a time` → two `add()` calls at once; the fake's `commandsReceived` shows the first job's `CloseProject` before the second's `File.Open`.
  - `prunes old failed folders`.
- [ ] **Step 2:** `bun test tests/job.test.ts` → FAIL.
- [ ] **Step 3:** Implement `runFile`: check (`<score-partwise` or `<score-timewise` in the first 2 KB) → mkdir `jobs/<timestamp>-<rand>/`, write `<sanitized name>.musicxml` → open, wait for a status with `hasScore:true` and an `activeOpenScoreID` not open before (remember `activeViewContainerID`) → `getlayouts`, full-score layout id → full `status()`; if active id ≠ job's, `Window.SwitchToLayout…` and re-check; still wrong → fail `focus` → export, poll the folder every 250 ms for a `.pdf` whose size is unchanged across two polls → read it → always (`finally`) close the job's project if opened, then confirm with `getstatus` that `activeOpenScoreID` is no longer the job's → delete the folder on success.
- [ ] **Step 4:** `bun test` → PASS; check passes. Commit `feat: Dorico job runner`.

### Task 4: Helper server

**Files:**
- Create: `src/helper/server.ts`, `src/helper/main.ts`, `src/helper/tailnet.ts`, `scripts/install-launchd.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: `DoricoClient`, `JobQueue`, `runFile`, `pruneJobs`.
- Produces:
  - `tailnetAddress(interfaces = os.networkInterfaces()): string | null` — first IPv4 in 100.64.0.0/10.
  - `startServer(opts: { hostname: string; port: number; token: string; client: DoricoClient; queue: JobQueue; maxBytes?: number }): { url: string; stop(): void }`
  - HTTP: `GET /health` → `200 {helper: <package version>, dorico: ClientState, variant, version, queue}`; `POST /jobs` multipart, one or more `file` fields → `200 {results: Array<{name, ok:true, pdf: <base64>} | {name, ok:false, step, message}>}`; no or wrong bearer → `401`; body over `maxBytes` (default 20 MB) → `413`; no files → `400`.

- [ ] **Step 1: tests** in `tests/server.test.ts` (server on `127.0.0.1`, random port, fake Dorico):
  - `tailnetAddress picks the 100.64/10 address` (fixture with `lo0`, `en0` 192.168.x, `utun4` 100.109.247.68) → `"100.109.247.68"`; none → `null`.
  - `401 without the token`, `401 with a wrong token`.
  - `health reports Dorico's state` (connected; then `kill()` → `"not running"`).
  - `a job returns each file's PDF` (two files) → two results, base64 decodes to `%PDF…`.
  - `concurrent jobs queue` → two simultaneous POSTs both succeed; fake shows no interleaving.
  - `413 for an oversized body`, `400 with no files`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `Bun.serve` (`req.formData()`); `main.ts` reads `ENV.MAC_BENCH_TOKEN`, `ENV.MAC_BENCH_PORT`, binds `tailnetAddress()` (exit 1 with a clear message if null), token file `~/Library/Application Support/mac-bench/dorico-token`, prunes failed job folders older than 3 days at start and daily. `scripts/install-launchd.ts` writes `~/Library/LaunchAgents/dev.lj.mac-bench.plist` (`RunAtLoad`, `KeepAlive`, `WorkingDirectory` the checkout, `ProgramArguments` `[<bun path>, "run", "helper"]`, `PATH` including `~/.bun/bin`, logs `~/Library/Logs/mac-bench.log`) and runs `launchctl bootstrap gui/$UID` (bootout first if loaded). **Step 4:** PASS + check. Commit `feat: helper server and launchd agent`.

### Task 5: CLI, live install, first real check

**Files:**
- Create: `src/cli/dorico.ts`, `src/cli/main.ts`, `tests/cli.test.ts`; Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the HTTP contract of Task 4.
- Produces: `dorico(args: string[], io: { url: string; token: string; out: (s: string) => void; err: (s: string) => void; fetch?: typeof fetch }): Promise<number>` — `--health` prints the health JSON; otherwise posts the files, writes `<out>/<basename>.pdf` (`--out`, default `dorico-runs/<YYYYMMDD-HHMMSS>/`), prints `ok <pdf path>` or `FAIL <name>: <step>: <message>` per file, returns 1 if any failed or the helper is unreachable (message names `MAC_BENCH_URL`).

- [ ] **Step 1: tests** against a real `startServer` + fake: `writes each PDF and prints its path`, `exits 1 and names the failed step`, `--health`, `unreachable helper names MAC_BENCH_URL`, `401 says the token is wrong`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `main.ts` reads `ENV.MAC_BENCH_URL`, `ENV.MAC_BENCH_TOKEN`, takes `dorico` as the subcommand. **Step 4:** PASS + check. Commit `feat: mac-bench dorico command`. Push `main`.
- [ ] **Step 5: Live install (over SSH, `ssh -i ~/.ssh/mac-bench_ed25519 -o IdentitiesOnly=yes kevinpeckham@kevins-macbook-pro-2021`, bun at `~/.bun/bin/bun`):** clone `https://github.com/kevinpeckham/mac-bench.git` to `~/projects/mac-bench`; `bun install`. **Kevin** puts `.env.local` (same `OP_ENV_ID`/`OP_TOKEN`) there. Run `bun run helper` once in the foreground; **Kevin** clicks Allow for `mac-bench`; stop it; `bun scripts/install-launchd.ts`.
- [ ] **Step 6: Live check from the VM:** `bun run mac-bench dorico --health` → `dorico: "connected"`, `Elements 6.2.31`. Then `bun run mac-bench dorico <barmark>/site/static/dorico-tests/{horns,piano-lines}.musicxml` → two `ok` lines; read both PDFs. Re-record with `scripts/record.ts` over SSH and update `tests/recordings/` if any shape differs (FINDINGS entry if so).
- [ ] **Step 7:** README's setup checklist matches what Step 5 did; CHANGELOG `[Unreleased]` lists the helper and the command. Commit `docs: setup checklist from the first install`; push.
