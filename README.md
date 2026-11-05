# mac-bench

Tests that need a Mac and its apps, driven from the bench VM. First:
**Dorico checks** — send MusicXML from the VM, get back the PDF Dorico
engraves from it, with no one at the Mac.

```
bin/mac-bench dorico horns.musicxml piano-lines.musicxml
ok dorico-runs/20261105-170000/horns.pdf
ok dorico-runs/20261105-170000/piano-lines.pdf
```

Design: [docs/superpowers/specs/2026-11-05-dorico-checks-design.md](docs/superpowers/specs/2026-11-05-dorico-checks-design.md).

## Setting up a Mac

What the first install (Kevin's MacBook, macOS 15.7, Dorico Elements
6.2.31) took:

1. **Dorico:** Preferences → General → Remote Control on, port 4560.
2. **Tailscale** on the Mac, signed in to the tailnet. The helper listens
   only on the Mac's tailnet address, port 7420.
3. **Bun** (`curl -fsSL https://bun.sh/install | bash`; `bun upgrade` if
   it's old). If `bunx --version` disagrees with `bun --version`, use
   `bun x` (or `ln -sf bun ~/.bun/bin/bunx`): see FINDINGS.
4. **Clone and install:** `git clone …/mac-bench ~/projects/mac-bench`,
   then `bun install`.
5. **`.env.local`** in the clone: `OP_ENV_ID` and `OP_TOKEN` for
   mac-bench's 1Password environment, which holds `MAC_BENCH_TOKEN`.
   Paste the token whole and nothing more: a stray character gives
   "invalid service account token". `bun x varlock load` checks it.
6. **The agent:** `bun scripts/install-launchd.ts` installs
   `dev.lj.mac-bench`, which starts at login and restarts if it stops.
   Log: `~/Library/Logs/mac-bench.log`, whose first line names the address.
7. **Allow:** the first time the helper connects, Dorico asks whether to
   allow mac-bench; click Allow. Its token is kept in
   `~/Library/Application Support/mac-bench/dorico-token`.
8. **From the VM:** `bin/mac-bench dorico --health` should say
   `"dorico": "connected"`.

While building, the VM reached the Mac over SSH (Remote Login on, a key
limited by `from="<VM tailnet IP>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding`).
The checks themselves need none of that: turn Remote Login off when done.

## Working beside it

The helper shares Dorico with whoever is using it. Each job opens a copy of
its file, exports it and closes it without saving, and never touches
anything else: if you click into your own project mid-job, the job stops
and says so, leaving its own project open for you to close (Don't Save).
