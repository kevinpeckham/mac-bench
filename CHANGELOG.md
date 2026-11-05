# Changelog

All notable changes to mac-bench. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Dorico checks:** `bin/mac-bench dorico <files>` sends MusicXML from the
  VM to a helper on the Mac, which has Dorico engrave each file and returns
  the PDFs; `--health` reports the helper, Dorico and the queue.
- The helper runs as a launchd agent on the Mac's tailnet address, with a
  bearer token from 1Password (varlock), and queues jobs one at a time.
- `scripts/record.ts` and `scripts/record-two.ts` record Dorico's Remote
  Control messages; the tests replay them through a fake Dorico.

### Changed

- `MAC_BENCH_URL` defaults to the cloud Mac (`mac-bench` on the tailnet).

### Safety

- A job only ever closes a project it has proved its own (its PDF landed
  in the job's folder, and it is in front); anything else is left open and
  reported, so a project of yours in the same Dorico is never closed.
