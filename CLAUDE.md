# CLAUDE.md — mac-bench

Tests that need a Mac and its apps, driven from the bench VM. First job:
Dorico checks of barmark's MusicXML — the VM sends MusicXML, a helper on
the Mac has Dorico engrave it, and the PDF comes back for Claude to read.
Design: `docs/superpowers/specs/2026-11-05-dorico-checks-design.md`.

## Layout

- `src/dorico/`: the Remote Control client (`client.ts`, `protocol.ts`,
  `token.ts`) and the job runner (`job.ts`)
- `src/helper/`: the HTTP helper that runs on the Mac (`main.ts` reads the
  environment; `server.ts` takes everything as arguments)
- `src/cli/`: `bin/mac-bench dorico …`, run on the VM (the wrapper keeps the caller's folder; `bun run` would not)
- `scripts/record.ts`: records real Dorico messages into `tests/recordings/`;
  `scripts/install-launchd.ts`: installs the helper as a launchd agent
- `tests/fake-dorico.ts`: a fake Remote Control server reproducing the
  recordings; every test runs against it, none needs Dorico or the env

## Commands

```
bun test                                   # tests (no env, no Dorico)
bun run check                              # Biome (tabs) and tsc
bin/mac-bench dorico <file.musicxml…>      # on the VM, from any folder: PDFs into ./dorico-runs/
bin/mac-bench dorico --health
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
