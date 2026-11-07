# CLAUDE.md — mac-bench

Tests that need a Mac and its apps, driven from the bench VM. First job:
Dorico checks of barmark's MusicXML — the VM sends MusicXML, a helper on
the Mac has Dorico engrave it, and the PDF comes back for Claude to read.
Design: `docs/superpowers/specs/2026-11-05-dorico-checks-design.md`.

## Layout

- `src/dorico/`: the Remote Control client (`client.ts`, `protocol.ts`,
  `token.ts`), the steps jobs share (`steps.ts`), the PDF job (`job.ts`)
  and the MusicXML export job (`export.ts`)
- `ax/`: MacBenchAX (`main.swift`, `Info.plist`), the one app granted
  Accessibility on the Mac; `src/ax/client.ts` launches it and reads its
  answers (`AxClient`, injected everywhere so tests use `tests/fake-ax.ts`)
- `src/helper/`: the HTTP helper that runs on the Mac (`main.ts` reads the
  environment; `server.ts` takes everything as arguments)
- `src/cli/`: `bin/mac-bench dorico …`, run on the VM (the wrapper keeps the caller's folder; `bun run` would not)
- `scripts/build-ax.ts`: builds and signs MacBenchAX on the Mac;
  `scripts/record.ts`: records real Dorico messages into `tests/recordings/`;
  `scripts/install-launchd.ts`: installs the helper as a launchd agent
- `tests/fake-dorico.ts`: a fake Remote Control server reproducing the
  recordings; `tests/fake-ax.ts` models Dorico's export dialogs as state;
  every test runs against fakes, none needs Dorico, a Mac or the env

## Commands

```
bun test                                   # tests (no env, no Dorico)
bun run check                              # Biome (tabs) and tsc
bin/mac-bench dorico <file.musicxml…>      # on the VM, from any folder: PDFs into ./dorico-runs/
bin/mac-bench dorico --export musicxml|mxl <files…>   # Dorico's MusicXML export: <base>.dorico.musicxml|mxl
bin/mac-bench dorico --health              # includes ax.trusted
bun scripts/build-ax.ts [--rebuild]        # on the Mac: build MacBenchAX (then grant it: README)
bun run helper                             # on the Mac (launchd runs this)
```

## Rules

- Dorico Elements 6.2.31: nothing Pro-only (no Lua). Remote Control on
  `ws://127.0.0.1:4560`.
- One job at a time; a fresh empty folder per file; never save a project;
  close only projects the helper opened, by `OpenScoreID`. Never read
  outside `~/Library/Application Support/mac-bench` on the Mac (a broad
  search once set off the Photos-library permission prompt).
- The helper listens on the Mac's tailnet address only (100.64.0.0/10),
  port 7420, and checks `Authorization: Bearer $MAC_BENCH_TOKEN`.
- varlock everywhere: `.env.schema` committed; `.env.local` holds only
  `OP_ENV_ID` and `OP_TOKEN`; `MAC_BENCH_TOKEN` comes from the mac-bench
  1Password environment. Only the entry points (`src/*/main.ts`) import
  `varlock/env`.
- MacBenchAX is never rebuilt without re-granting it: its ad-hoc grant is
  tied to its build (FINDINGS). Change `ax/main.swift` only for a strong
  reason; `build-ax.ts` refuses without `--rebuild`, then
  `tccutil reset Accessibility dev.lj.mac-bench.ax` and grant again
  (README). It acts only on Dorico by bundle ID, types only while Dorico is
  frontmost, and answers only inside the work folder.
- An export job types nothing but the folder path, presses OK only in
  Export MusicXML, and always runs its failsafe (cancel every dialog) and
  closes its project unsaved.
- The repo is public: never commit a Dorico session token or any secret.
- Test first; conventional commits with no Co-Authored-By or other AI
  trailer; a CHANGELOG `[Unreleased]` entry per user-visible change; a
  FINDINGS.md entry whenever Dorico, a tool or our process surprises us.

## The Mac

The cloud Mac since 2026-11-05: a MacStadium M2.XL in Dublin, macOS 27.2,
`mac-bench` on the tailnet (`MAC_BENCH_URL`'s default), user
`administrator`, auto-login on, Dorico Elements 6.2.31 open with Remote
Control on port 4560. Claude reaches it with
`ssh -i ~/.ssh/mac-bench_ed25519 -o IdentitiesOnly=yes administrator@mac-bench`
(no sudo: give Kevin root commands to run, with no backslashes in them,
see FINDINGS; Bun is `~/.bun/bin/bun`). MuseScore 4.7.6 is a Homebrew cask (`brew install --cask
musescore`, 2026-11-05): `mscore` converts headless, after
`eval "$(/opt/homebrew/bin/brew shellenv)"`. SSH accepts keys only. Plan and
status: `docs/cloud-mac-plan.md`. Kevin's MacBook
(`kevins-macbook-pro-2021`) also still runs the helper: point
`MAC_BENCH_URL` at it to use it.
