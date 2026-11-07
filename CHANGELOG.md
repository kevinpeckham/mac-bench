# Changelog

All notable changes to mac-bench. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Dorico checks:** `bin/mac-bench dorico <files>` sends MusicXML from the
  VM to a helper on the Mac, which has Dorico engrave each file and returns
  the PDFs; `--health` reports the helper, Dorico and the queue.
- The helper runs as a launchd agent on the Mac's tailnet address, with a
  bearer token from 1Password (varlock), and queues jobs one at a time.
- **Dorico MusicXML export:** `bin/mac-bench dorico --export musicxml|mxl
  <files>` has Dorico import each file and export it again through its own
  Export MusicXML dialog, writing `<input>.dorico.musicxml` (or
  `.dorico.mxl`); the helper takes it as `POST /jobs` with `export=musicxml`
  or `export=mxl` (anything else is a 400) and returns the file base64 in
  `file`. PDF and export jobs share one queue.
- **MacBenchAX** (`ax/`), a small Swift app, the only program on the Mac
  granted Accessibility, answers Dorico's dialogs for the export job;
  `scripts/build-ax.ts` builds and signs it (refusing to replace a built
  one without `--rebuild`, since a new build loses its grant).
- `/health` (and `--health`) reports `ax: { trusted }`: whether exports
  will work.
- `scripts/record.ts` and `scripts/record-two.ts` record Dorico's Remote
  Control messages; the tests replay them through a fake Dorico.

### Changed

- `MAC_BENCH_URL` defaults to the cloud Mac (`mac-bench` on the tailnet).

### Safety

- A job only ever closes a project it has proved its own (its PDF landed
  in the job's folder, and it is in front); anything else is left open and
  reported, so a project of yours in the same Dorico is never closed.
- An export job starts only when Dorico shows no dialog or open menu, and
  cancels every dialog (and closes any menu) it leaves open (Cancel, then
  Escape, up to four rounds), naming any it couldn't close; the only text
  it types is the export folder's path, the only OK it presses is the
  Export MusicXML dialog's, and Return goes only to the Go to Folder sheet
  holding that path. MacBenchAX acts only on Dorico (by bundle ID),
  types only while Dorico is frontmost, writes only inside the helper's
  work folder, and is signed with the hardened runtime (no `DYLD_*`
  injection).
