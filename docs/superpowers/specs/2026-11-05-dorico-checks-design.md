# Dorico checks: design

Status: for Kevin's approval, 2026-11-05.
Repo: `kevinpeckham/mac-bench` (new).

## Why

barmark exports MusicXML (`@barmark/musicxml`, `barmark export --musicxml`).
Whether Dorico reads that MusicXML correctly can only be learnt by importing it
into Dorico and looking at the result. Until now that meant Kevin downloading
each test file, importing it, exporting a PDF, uploading the PDF and pasting
the link back to Claude: slow for him, and it stalls Claude's work (merges and
releases wait on each check).

The aim is a check Claude starts and reads on its own: Claude, on the bench VM,
sends MusicXML to a Mac running Dorico and gets the PDF back, with no one at
the Mac. Kevin no longer looks at each PDF; Claude does, and carries on.

The Mac is Kevin's laptop at first. Kevin's stated goal is a cloud-hosted Mac
for automated testing across barmark and Stem Shovel; this design must move
there unchanged.

## Goals

- From the bench VM, one command turns a MusicXML file into the PDF Dorico
  engraves from it, saved on the VM, with no human action per job.
- Several files in one call (a test set), each giving its own PDF.
- Runs on Kevin's laptop while he works (opening and closing projects in his
  Dorico is acceptable, Kevin 2026-11-05), and later on a cloud Mac with no
  code changes.
- Fails loudly: a job that cannot finish returns an error saying which step
  stopped, never hangs the caller or leaves Dorico stuck on a dialog it
  could have avoided.

## Non-goals (for now)

- Uploading PDFs anywhere (DigitalOcean Spaces dropped by Kevin: the PDF comes
  back to the VM).
- Judging the PDF automatically (Claude reads it; image diffing may come later).
- Stem Shovel jobs, other apps (MuseScore, Logic), MusicXML export *from*
  Dorico, provisioning the cloud Mac. The design leaves room for them.
- Any Dorico Pro feature (Kevin has **Dorico Elements 6.2.31**; Lua scripting
  is Pro only).

## Anti-goals

- Touching Kevin's own projects: the helper only ever closes projects it
  opened, by ID.
- Reading folders outside its own work directory (a broad `find` in the spike
  set off macOS's Photos-library permission prompt).
- Being reachable from outside the tailnet.
- Secrets in the repo (varlock, as in Kevin's other repos).

## What the spikes established (Dorico Elements 6.2.31, macOS, 2026-11-05)

Dorico's Remote Control API: WebSocket on `ws://127.0.0.1:4560` (enabled in
Preferences > Remote Control). Messages are JSON.

- **Handshake.** Send `{"message":"connect","clientName":…,"handshakeVersion":"1.0"}`.
  The first time, Dorico shows an Allow prompt and replies
  `{"message":"sessiontoken","sessionToken":…}`; answer
  `{"message":"acceptsessiontoken","sessionToken":…}` → `{"message":"response","code":"kConnected"}`.
  Later connects include `sessionToken` and need no click. The token is kept
  in a file only the helper reads (mode 600).
- **Discovery.** `getappinfo` (`info: "version"`) → `{"message":"version","variant":"Elements","number":"6.2.31"}`.
  `getcommands` → the full list (935 commands, with required and optional
  parameters). `getstatus` → a full status (`hasScore`, `activeOpenScoreID`,
  `windowMode`, …); Dorico also pushes partial `status` messages unprompted.
- **Commands** are `{"message":"command","command":"Name?Param=Value&…"}`;
  the reply `{"message":"response","code":"kOK"}` means accepted, **not**
  finished.
- **Open:** `File.Open?File=<absolute path>` imports MusicXML as a new
  project with no dialog (~2 s for a small file).
- **Export:** `Print.ExportCurrentLayoutAsPDF` (no parameters) writes the
  current layout, in Write mode, to the **folder of the opened file**, named
  `01 - Full score - <title>.pdf`. If that file exists, Dorico shows a
  modal "One or more output files already exist" dialog (Create New /
  Overwrite) and waits. No export command takes a folder.
- **Close:** `File.CloseProject?Save=false` closes with no save dialog
  (`File.Close` shows "Save changes…?").
- **Save to a path is not possible:** `File.Save?File=…` opens the Save
  dialog. The helper never saves.
- `Window.SwitchMode?WindowMode=kPrintMode` answered `kOK` but status still
  said Write mode; it isn't needed.

## How it works

Two parts, both TypeScript on Bun (Kevin's other repos' toolchain: Bun,
TypeScript strict, Biome with tabs, varlock).

### The helper (runs on the Mac)

A long-running Bun HTTP server, kept alive by a launchd user agent, listening
on the Mac's tailnet address only.

It owns the one Remote Control connection (reconnecting with the saved token
when Dorico restarts) and runs **one job at a time**; jobs queue.

For each file in a job:

1. Make a new, empty job folder under its work directory, and write the
   MusicXML into it. A fresh folder per file means the PDF never exists
   beforehand, so the overwrite dialog cannot appear.
2. `File.Open?File=<that file>`; wait until status reports a new
   `activeOpenScoreID` (the project to close later) and note its
   `activeViewContainerID`.
3. Check, just before exporting, that `activeOpenScoreID` is still the
   job's project. The export command takes no project, so it exports
   whatever is in front: if Kevin has clicked into his own project, the job
   must not export it. If focus moved, bring the job's project back with
   `Window.SwitchToLayout` (open score, view container and layout IDs) and
   check again; if that fails, the job fails with "focus moved" (my call;
   untested, see "Unverified").
   Then `Print.ExportCurrentLayoutAsPDF`; wait for a `.pdf` to appear in the
   job folder and its size to stop changing.
4. `File.CloseProject?OpenScoreID=<id>&Save=false`; confirm that project is
   gone.
5. Return the PDF.

Each wait has a timeout; on timeout the job fails with the step's name and
the helper still tries step 4 for any project it opened, so Dorico is left
clean.

**Amended 2026-11-05, after the final review and a recording with two
projects open (`tests/recordings/two-projects.log`):** a pushed status
leaves out `hasScore` while it stays true, Dorico's project IDs only grow,
and `Window.SwitchToLayout` answers `kOK` but switches nothing. So step 2
takes the first project with an ID above any seen on the connection; step
3 has no switch back (a job whose project isn't in front stops at "focus")
and checks focus again right after the export; and step 4 closes a project
only once it has proved itself the job's (its PDF landed in the job's
folder) and is in front. Anything less leaves the project open and says
so, rather than "Dorico is left clean": a stray project is a nuisance, a
closed one of Kevin's is lost work. Job folders are deleted after a successful job and kept (for
inspection) after a failure, pruned after a few days.

Endpoints (my call; small, JSON in and out):

- `GET /health` → helper version, Dorico reachable, Dorico variant and
  version, queue length.
- Exports the **full score only** (Dorico's first layout), which is what
  every check so far has used (my call). Part layouts
  (`Print.ExportAllLayoutsAsPDF`) are a later option; the response is
  already a list of PDFs per file so adding them changes no shapes.
- `POST /jobs` with one or more MusicXML files (multipart) → once done, each
  file's PDF (or its error with the step that failed). Synchronous: the call
  returns when the job ends; a whole test set is a few seconds per file.

Access: tailnet only, plus a shared bearer token, so another device on the
tailnet can't drive Dorico by accident.

### The command (runs on the bench VM)

`mac-bench dorico <file.musicxml…> [--out <dir>]`: posts the files to the
helper, writes each PDF to `--out` (default: a folder per run), prints one
line per file (PDF path or error) and exits non-zero if any failed. Claude
then reads the PDFs.

### Configuration and secrets (Kevin, 2026-11-05: 1Password and varlock)

As in Kevin's other repos: `.env.schema` committed, read through
`import { ENV } from "varlock/env"`, and values from a **mac-bench
1Password environment** Kevin creates. Each machine's gitignored
`.env.local` holds only `OP_ENV_ID` and `OP_TOKEN`. The environment holds
`MAC_BENCH_TOKEN` (the shared bearer token, a long random string).
Non-secret settings live in the schema with defaults: the helper's address
for the VM (`MAC_BENCH_URL`, default the laptop's tailnet name,
`http://kevins-macbook-pro-2021:7420`; port 7420 my call) and the helper's
listen port and work directory. Moving to the cloud Mac changes only
`MAC_BENCH_URL`.

### Building (Kevin, 2026-11-05)

While building, Claude may run commands on Kevin's laptop over SSH from
the bench VM (macOS Remote Login, a key made for this purpose and limited
to the VM's tailnet address), so the recording script and live tests run
without Kevin. Kevin can turn Remote Login off after the build.

**Dorico not running** (or the Mac asleep / off the tailnet): the job, or
`/health`, fails at once with a plain message. The helper does not launch
Dorico itself, which would mean handling its startup, Hub window and
licence (my call; revisit for the cloud Mac, where Dorico opens at login).

## Unverified (the first build step checks these)

The spikes did not try: closing by ID (`File.CloseProject?OpenScoreID=…`),
`Window.SwitchToLayout`, a saved token after Dorico restarts, how reliably
status reports the new `activeOpenScoreID`, what a bad command or stale
token replies, and whether any MusicXML import raises a dialog. Their raw
logs stayed on Kevin's Mac. So the plan starts with one recording script,
run on the Mac, that tries each of these and saves every message to a
file committed under `tests/recordings/`; the fake Dorico replays those,
not guesses.

## Setting up a Mac (one time, by hand)

Written up in the repo's README as a checklist:

1. Dorico installed and licensed; Remote Control on, port 4560.
2. Bun installed; the repo cloned; `bun install`.
3. `.env.local` with the mac-bench 1Password environment's `OP_ENV_ID`
   and `OP_TOKEN`.
4. Run the helper once in a terminal and click **Allow** in Dorico.
5. Install the launchd agent (a script in the repo writes it).
6. From the VM: `mac-bench dorico --health` (or `GET /health`) answers.

On a cloud Mac the same list applies; the licence and the one Allow click are
done once over screen sharing.

## Testing

- The Remote Control client is tested against a fake Dorico (a local
  WebSocket server that replays the messages the spikes recorded), covering
  the handshake with and without a token, a command's `kOK`, unprompted
  `status` messages, a timeout, and Dorico going away mid-job.
- The job runner is tested against the fake: one file, several files,
  a failure at each step still closes what it opened, the queue runs jobs
  one at a time.
- One live test, run by hand on a Mac with Dorico, turns a small MusicXML
  file into a PDF end to end.

## Left to the builder

Module layout, the HTTP framework (or none), the multipart handling, the
exact timeouts and polling, launchd plist details, log format, and how the
fake Dorico is built.

## Later

- Stem Shovel jobs and other apps as further job types on the same helper.
- A barmark "suite": the chart files Claude regenerates and checks on each
  MusicXML change.
- PDF-to-image comparison against approved results.
- The cloud Mac (Kevin's goal): same helper, new address in varlock.
