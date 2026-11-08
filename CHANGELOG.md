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
- **Dorico MIDI import:** `bin/mac-bench dorico --midi [--export
  musicxml|mxl] <file.mid…>` has Dorico import each Standard MIDI File,
  accept its MIDI Import Options window as it comes (OK or Return, no
  option changed) and export the result as MusicXML (default) or `.mxl`,
  written as `<base>.dorico.musicxml`; when the window was a readable
  dialog, what it showed (its two checkboxes and each track's name,
  instrument, destination and note counts) is written beside it as
  `<base>.midi-import.json`. The helper takes it as
  `POST /jobs` with `import=midi` (anything else is a 400), the files as
  bytes; a file not starting with `MThd` is refused, by the CLI before
  sending and by the job. A job that fails at the window says how many
  windows Dorico showed before and after, and to Cancel the window on the
  Mac.

### Fixed

- The MIDI job works against the real Dorico: its first live run failed
  with "MIDI Import Options window didn't show" while the window was open,
  because Dorico's standard windows describe themselves to Accessibility as
  the application (no title, no contents), so the window couldn't be found
  by title, read or pressed. The job now counts Dorico's windows: when there
  is one more after `File.Open` and no new project, it sends Return once
  (the window's default button is OK) and waits for the project. A project
  that appears without the window showing first is never taken (a score ID
  can't prove it came from the job's file): the job stops and leaves it
  open, to be closed on the Mac without saving. The tracks table is no
  longer recorded: `<base>.midi-import.json` and the result's
  `importWindow` are gone. An export job whose `File.Open` makes nothing
  says a window Accessibility can't see (such as a MIDI Import Options
  window) may be in the way.
- The MIDI job handles both shapes Dorico's import window takes: with no
  project open (the Hub only) it is a readable dialog titled "MIDI Import
  Options", which the count-only job missed in its second live run ("1
  before File.Open, 1 now"); it is now found by title, read
  (`importWindow`, `<base>.midi-import.json` again) and accepted with its
  OK scoped to dialogs. With a project window open it is opaque and still
  accepted with Return.
- A Return or OK that certainly wasn't sent (MacBenchAX refused it,
  couldn't be launched, or Dorico couldn't be brought forward) now fails
  at once; only one that may have gone (no answer in time, `AxNoAnswer`)
  waits for the project and records it. Before, any failure waited and
  could record, and close, a project of someone else's.
- The wait for the project after Return or OK no longer shares one time
  budget with the steps before it, so a slow MacBenchAX can't make it
  report "Return didn't take" early.

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
- OK in Dorico's MIDI Import Options window is pressed only when it is a
  readable dialog and the one dialog open, scoped with `--dialogs`; Return
  is sent to it only when it is opaque, once, never retried, and only when
  Dorico's non-dialog window count rose by exactly one (an opaque window)
  after opening the `.mid`, no project has appeared, and no dialog, sheet
  or menu is open, checked again just before it. No press is ever sent
  outside `--dialogs`. Once Return or OK may have gone (no answer in
  time), a failure still waits for the project and closes it, or says to
  close it if it comes later; a project that appears without the window,
  or after it showed and before it was accepted, is never taken for the
  import. The failsafe cancels a dialog-shaped import window; it can't see
  an opaque one, and a job that fails with one open says to Cancel it on
  the Mac.
