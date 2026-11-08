# Findings

Things Dorico, our tools or our process did that surprised us: the
symptom, the cause, the fix and where it lives.

## Dorico Remote Control (Elements 6.2.31, macOS, 2026-11-05)

### `File.Save?File=<path>` opens the Save dialog

Symptom: the spike asked Dorico to save to a path; Dorico showed its Save
dialog and waited. Cause: the `File` parameter isn't honoured for a new
project. Fix: the helper never saves; it closes with
`File.CloseProject?OpenScoreID=…&Save=false`, which shows no dialog
(`File.Close` asks "Save changes…?").

### The PDF goes beside the opened file, and an existing one blocks

Symptom: `Print.ExportCurrentLayoutAsPDF` answered `kOK` but the spike
found no PDF where it looked; later exports stopped on "One or more output
files already exist" (Create New / Overwrite). Cause: no export command
takes a folder; Dorico writes `01 - Full score - <title>.pdf` beside the
MusicXML it opened. Fix: a fresh, empty folder per file (`src/dorico/job.ts`).

### Remote Control can't export MusicXML (but Accessibility can)

Symptom: no way to get MusicXML out of Dorico through Remote Control:
`File.Save?File=` is ignored (above), and `File.Export` lists no filter
IDs to choose MusicXML with. Fix: the export job answers Dorico's own
Export MusicXML dialog through macOS Accessibility instead; see
"Dorico's MusicXML export, through Accessibility" below
(`src/dorico/export.ts`).

### With a project open, a new one is announced without `hasScore`

Symptom (final review, then `tests/recordings/two-projects.log`): every job
started while another project was open would have failed at "open". Cause:
pushed statuses carry only what changed, and `hasScore` stays true, so the
push naming the new project has no `hasScore`; the helper waited for one.
Fix: a new project is the first with an ID above any seen on the
connection; Dorico's IDs only grow (`highestScoreID` in
`src/dorico/client.ts`).

### `Window.SwitchToLayout` answers `kOK` and switches nothing

Symptom: asked to bring one of two projects to the front, Dorico replied
`kOK` and the other stayed in front. Fix: no switch back; a job whose
project isn't in front stops at "focus" and leaves it open
(`src/dorico/job.ts`). The design had trusted the fake, which switched.

### After a close, no window is active

Symptom: with two projects open, closing the front one left Dorico
reporting `hasScore: false`, and `File.CloseProject` for the other got
`kCommandNotAllowed`; the other project was still open (Kevin checked).
Cause: no project is in front until someone clicks one. Fix: a job closes
only its own project while it is in front; `File.Open` still works then.

### Replies are matched in order, so a late one answered the wrong request

Symptom (final review): a reply arriving after its request timed out would
resolve the next request, and every later one, shifted by one. Fix: a
request that times out drops the connection, which reconnects clean
(`src/dorico/client.ts`).

### An unknown session token gets no reply

Symptom: a connect with a token Dorico doesn't know got nothing back.
Cause: Dorico shows its Allow prompt and waits for a click. Fix: the
client reports "waiting for Allow in Dorico" instead of hanging
(`src/dorico/client.ts`).

### The status pushed after a close keeps the closed project's ID

Symptom: after `File.CloseProject?OpenScoreID=35&Save=false` Dorico pushed
`{"activeOpenScoreID":35,…,"hasScore":false}`. Cause: the push carries the
last active ID. Fix: confirm a close with a fresh `getstatus`, whose
`activeOpenScoreID` is gone or another project's.

## Dorico's MusicXML export, through Accessibility (macOS 27.2, 2026-11-07)

### Dorico's own dialogs can be driven unattended

Symptom: the spike drove File > Export > MusicXML... through MacBenchAX
(`ax/main.swift`) for five files with no one at the Mac. What it found:
the menu item is titled `MusicXML...` (three ASCII dots); the dialog is an
`AXDialog` titled `Export MusicXML` with checkboxes `Export compressed XML
(.mxl)`, `Export uncompressed XML (.musicxml)`, one per flow (under
"Select flows to export:"), `Export layouts as separate files`, one per
layout (`Full score`, `01_Voice`, …) and `Create folder for exported
files`; its "Export to:" label's identifier ends `folderPathLabel`. The
folder button is titled with a private-use glyph (U+E0C8; identifier ends
`chooseFolderPathPushButton`) and opens a standard Open panel: Cmd-Shift-G
gives a sheet whose one text field takes a path, Return goes there (the
`Where:` pop-up then names the folder) and Choose sets "Export to:". With
Dorico 6.2's defaults the export went into a `Flows from <project>`
folder, one file per layout (`Hymn - Full score - 01 Hymn.musicxml`,
`Hymn - 01_Voice - 01 Hymn.musicxml`). Fix: the job turns "Create folder"
and "separate files" off and "Full score" on, pressing a checkbox only when
it differs, re-reads them, and takes the `Full score` file if Dorico still
writes several (`src/dorico/export.ts`).

### An ad-hoc signed app's Accessibility grant is tied to the build that asked

Symptom: the spike rebuilt MacBenchAX after its first `trusted` check; the
toggle in System Settings stayed on but `AXIsProcessTrusted` stayed false.
tccd logged "Failed to match existing code requirement for subject
dev.lj.mac-bench.ax". Cause: an ad-hoc signature has no stable identity,
so the grant records the first build's code hash. Fix:
`tccutil reset Accessibility dev.lj.mac-bench.ax`, `request` from the build
in place, grant again; and never rebuild casually: `scripts/build-ax.ts`
refuses to replace a built app without `--rebuild`, and then prints these
steps.

### macOS 27 moved Accessibility

Symptom: Accessibility isn't where macOS 15 kept it. Cause: macOS 27 has
it under System Settings > Privacy & Security > Device Control and Data
Access. Fix: MacBenchAX's own `request` (AXIsProcessTrustedWithOptions with
the prompt) adds it to the list and opens the right pane.

### Dorico's running-app name is "Dorico", not "Dorico 6"

Symptom: an app looked up by the name it is installed under, "Dorico 6",
isn't running as far as `NSRunningApplication.localizedName` goes. Cause:
the bundle is `Dorico 6.app` (so `open -a "Dorico 6"` works) but the
running app calls itself "Dorico"; its bundle ID is `com.steinberg.dorico6`.
Fix: MacBenchAX now finds it by bundle ID (next entry); the helper brings it
forward with `open -a "Dorico 6"` (`src/helper/main.ts`).

### `open -W` can't wait for an app that exits at once

Symptom: "Unable to block on application" from `open -W -a MacBenchAX.app`.
Cause: MacBenchAX answers and exits before `open` can watch it. Fix: wait
for its answer file instead, bounded (10 s), then read and delete it
(`src/ax/client.ts`); `open -n` so each call is a new instance even if the
last one hasn't quite gone.

### MacBenchAX narrowed after a security review (2026-11-07)

Symptom: as spiked, MacBenchAX acted on any app named by `--app`, posted
keys to whatever was frontmost, and wrote its answer wherever `--out`
said; a program granted Accessibility can do a lot. Fix
(`ax/main.swift`): `--app` is a bundle ID, allowlisted to
`com.steinberg.dorico6` (the default), matched by bundle ID rather than
name (a running app's name can be anything); `keys` refuses (exit 5, a JSON
error) unless the frontmost app is allowlisted, so the job brings Dorico
forward before every key step and treats a refusal as that step's failure;
`--out` is required, even for `request`, and must be a `.json` file
directly in `~/Library/Application Support/mac-bench/ax/answers/`
(otherwise exit 65; a missing answers folder, or a link in its place, is
exit 66; both say why on stderr and write nothing), its `.part` created
exclusively and renamed into place, 0600; and
`scripts/build-ax.ts` signs it with the hardened runtime
(`codesign --options runtime`, no entitlements), so `DYLD_*` variables
can't inject code into the process that holds the grant. Still
true, and accepted: any program running as this user can launch it, so the
grant's reach is only as narrow as the allowlist: Dorico, on a
single-user Mac.

### Review of the export job: what the fakes hid (2026-11-07)

Symptom: a review found the job would have failed or misbehaved live in
ways the tests passed: a floating window (Mixer, Key Editor) counted as a
dialog, so OK was refused and the failsafe reported it every job; a
dialog stuck from one job would have been taken by the next, which would
have returned the earlier job's export; a menu left dropped down was
invisible to the failsafe; Return sent after the Go to Folder sheet had
gone would have been the Open panel's Choose (Dorico's remembered folder)
or the dialog's OK; and the fake's `dismiss` closed the Go to Folder sheet,
which the real one can't (the sheet has no Cancel), so the tests passed
for the wrong reason. Cause: a fake more capable and more forgiving than
the real thing, and TypeScript and Swift each with its own idea of a
dialog. Fix: one rule (`DIALOG_SUBROLES`, `src/ax/client.ts`, matching
main.swift's isDialog); a preflight that fails the job if anything is
open; the menu retried once after Escape; Return only into the sheet
holding the path; `--dialogs` on every look and press, so a document
window's tree (with decoy OK and Cancel buttons in the fake) is never
searched; and a fake that behaves exactly like main.swift
(`tests/fake-ax.ts`). Rule: a fake of a UI is checked against the real
program's code, not against what the spike happened to see.

### The first live runs: three timing gaps the spike's pauses had hidden (2026-11-07)

- **A checkbox missing right after another was toggled.** The first job
  stopped at options with "nothing titled Export layouts as separate
  files", although the dialog had it. Cause: after a checkbox changes,
  Dorico (Qt) rebuilds the dialog's accessibility tree and for a moment
  lists nothing in it; the spike waited over a second between steps, the
  job didn't. Fix: a press that finds nothing is tried again until
  `dialogMs` (`press` in `src/dorico/export.ts`; fake `rebuildLooks`).
- **A lost ⌘⇧G.** One job in ten stopped at "the Go to Folder sheet
  didn't show". Cause: the Open panel was listed before it took keys.
  Fix: ⌘⇧G once more (fake `goToLostOnce`).
- **Return that closed the sheet without going there.** Two jobs in three
  stopped with "Where: shows Dorico Projects": the sheet held the path,
  Return closed it, the panel stayed put. Cause: Return sent at once after
  the path was set through Accessibility; with the spike's pause it
  always went. Fix: `settleMs` before Return, and the Go to Folder step
  once more if the panel stays put (fake `goToMissesOnce`). The Where:
  and "Export to:" checks caught all three before OK, so nothing was
  exported to a wrong folder. After the fixes: ten exports in a row (five
  fixtures, `.mxl` and `.musicxml`), each identical to the spike's.

## Dorico's MIDI import (Elements 6.2.31, 2026-11-08)

### The MIDI Import Options window is a standard window, which `--dialogs` misses

Symptom: `File.Open?File=<path>.mid` answered `kOK` but `hasScore` stayed
false; Dorico showed a window titled "MIDI Import Options" (track memory,
General MIDI, the tracks table, Cancel / OK) and waited. The export job's
preflight (`dump --dialogs`) didn't see it, and the next job's `File.Open`
timed out behind it. Cause: the window has traffic-light buttons, a
standard window rather than an `AXDialog`, and `--dialogs` looks only at
dialogs and sheets. Fix: the import window counts as a dialog wherever one
is checked for (`blocking`, `src/dorico/export.ts`): it is found by title
in a one-level full dump, and pressed with an unscoped `press --after
"MIDI Import Options"`, only once a full dump as deep as the press looks
shows the press lands in that window (`pressInImport`,
`src/dorico/import-window.ts`). The MIDI job accepts it with OK and waits
for the project (`src/dorico/midi.ts`); the failsafe cancels it.

Correction (the same day): the window could not in fact be found by title
or pressed with `--after`; that fix was built against fakes, never against
a real dump. See "Dorico's standard windows describe themselves as the
application" below for what the live run showed and what replaced it.

### Dorico's standard windows describe themselves as the application

Symptom: the first live MIDI job failed with "Dorico's MIDI Import Options
window didn't show within 30000 ms; windows seen: AXApplication "Dorico"
[AXApplication "Dorico", AXApplication "Dorico", AXMenuBar]; AXApplication
"Dorico" [AXApplication "Dorico", AXApplication "Dorico", AXMenuBar]",
while Kevin's screenshot showed the window open over the project window,
titled "MIDI Import Options" (tracks Voice to Voice 1, Voice chords to
Voice 2, Acoustic Guitar to Acoustic Guitar 1). The next job, an export,
then timed out in `File.Open` behind it; its preflight had seen nothing.
Cause: Dorico's Qt standard windows (project windows and the import
window) are listed in the app's AXWindows, but each describes itself as
the application: AXRole "AXApplication", AXTitle "Dorico", no subrole, and
as children the app's own children again (its windows, again as
AXApplication, then the AXMenuBar). A self-similar tree with no window
title and no contents: the window can't be found by title, its tracks
table can't be read, and `press --after "MIDI Import Options"` can't be
aimed at it. A deep dump of it grows as the number of windows to the power
of the depth: never do one. Dialogs (AXWindow/AXDialog, such as Export
MusicXML) and sheets are described properly, which is why the export job
works. The fakes had guessed the import window was an
AXWindow/AXStandardWindow with readable contents; no one had compared
that with a real dump. Fix: the MIDI job counts Dorico's non-dialog
windows (`dump --depth 0`) just before `File.Open`; the window has shown
when there is one more and no new project. It then sends Return once,
never retried, after checking again that nothing else is open, the count
is still one up and no project has appeared (Kevin, live: with the window
freshly shown and active, one Return closed it and Dorico made the
project; OK is its default button). A project that appears without the
window showing first is never taken, exported or closed: a score ID can't
prove it came from the job's file, and closing someone else's project
unsaved loses their work; the job stops and leaves it open. The tracks
table is no longer recorded (`src/dorico/midi.ts`,
`src/dorico/import-window.ts`; the fakes now model standard windows as the
real ones describe themselves). The export job's `File.Open` timeout says
such a window may be in the way. Rule: check a fake's shape against a real
dump before trusting it.

Remaining risk, accepted: Return goes to whichever Dorico window is key,
and Accessibility can't say which that is (checking would need a
MacBenchAX rebuild). Right after a `.mid` opens, it has been the import
window (Kevin's live test); in a project window with nothing selected,
Return does nothing harmful, and the job never saves a project. A
floating window opening or closing near `File.Open` could also give a
false N+1; no live dump has checked this yet.

Correction (the next run): this holds only while a project window is open;
with only the Hub, the import window is a readable dialog. See "The import
window's shape depends on Dorico's state" below.

### The import window's shape depends on Dorico's state

Symptom: the count-only job's first live run, with only the Steinberg Hub
open, failed with "Dorico's MIDI Import Options window didn't show within
30000 ms, and no project came; … Dorico's windows numbered 1 before
File.Open, 1 now (AXWindow/AXDialog "MIDI Import Options" [AXGrowArea,
AXStaticText, AXStaticText, AXCheckBox "Use track memory", AXCheckBox
"Interpret as General MIDI", AXStaticText, AXCheckBox "Basic editor",
AXCheckBox "Advanced editor", … 15 more]; AXWindow/AXStandardWindow
"Steinberg Hub" [AXStaticText, AXButton "Open Recent", AXButton "Create
New", …])". The run before, with a project window open, had seen only
opaque windows: "AXApplication "Dorico" [AXApplication "Dorico",
AXApplication "Dorico", AXMenuBar]; AXApplication "Dorico" [AXApplication
"Dorico", AXApplication "Dorico", AXMenuBar]". Cause: Dorico's windows
describe themselves in one of two ways by its state. With no project
open, the Hub is an AXWindow/AXStandardWindow and the import window a
proper, readable AXWindow/AXDialog; the count ignores dialogs, so it
stayed at 1. With a project window open, the standard windows and the
import window all describe themselves as the application (the entry
above). Fix: the job takes either. A window titled "MIDI Import Options"
in a one-level dump is the import window (preflight saw no dialog, so it
is the job's): it is read from a `--dialogs` dump (`importWindow`,
`<base>.midi-import.json`), and, when it is the one dialog open, its OK
is pressed scoped with `--dialogs` and the window checked gone. Otherwise
one more non-dialog window, an opaque one, is the import window, accepted
with Return as before. Preflight refuses a leftover dialog-shaped one like
any dialog; the failsafe's `dismiss` cancels the job's own (its Cancel).
The fakes model both (`importShape`; by default opaque while a project
window is open, which `connect` now opens for each project). Rule, again:
a fake's shape stands for one real dump in one state; look at the others.

### A failed Return was treated as one that may have gone (review, 2026-11-08)

Symptom: a review of the count-and-Return job found that when Return
certainly wasn't sent (Dorico not brought forward, MacBenchAX refusing
because another app was frontmost, its launch failing), the job still
waited for a project and recorded the first newer one, which `wrapUp`
would close unsaved: possibly someone else's. It also found the wait for
the project shared one time budget with the steps before it, so a slow
MacBenchAX could make it report "Return didn't take" early. Cause: one
catch for every failure, and one watcher started before File.Open. Fix:
`activate()` before the send; only `AxNoAnswer` (MacBenchAX launched but
gave no answer in time, `src/ax/client.ts`) counts as "may have gone";
the project is waited for afresh after the send, and the "no new project"
checks read `highestScoreID` directly (`src/dorico/midi.ts`).

### A probe outside the helper left Dorico blocked

Symptom: a `.mid` opened over Remote Control from an SSH probe left the
import window up, with nothing able to close it. Cause: MacBenchAX can't be
launched from SSH (no GUI session; `launchctl asuser` needs root), so only
the helper, a launchd agent in the GUI session, can answer Dorico's
windows. Fix: always go through the helper (CLAUDE.md rule); its MIDI job
cancels the window whatever happens. (Correction: it can't, as the entry
above found; a job that fails at the import says to Cancel the window on
the Mac.)

## Process

### A broad file search set off macOS's Photos permission prompt (2026-11-05)

Symptom: the spike's `find "$HOME"` made macOS ask whether WezTerm may
access the Photos library. Cause: walking `~/Pictures`. Fix: the helper
reads only its own work directory (CLAUDE.md rule).

## Setting up the Mac (2026-11-05)

### `bunx` was older than `bun`

Symptom: varlock refused to run ("Bun >= 1.3.3 … using 1.3.2") though
`bun --version` said 1.4.4. Cause: Bun was installed as a global npm
package, where `bunx` is a separate copy that `bun upgrade` doesn't
replace. Fix: `bun x` everywhere in the setup; relinking
`~/.bun/bin/bunx` to `bun` also works.

### "invalid service account token" from a pasted `OP_TOKEN`

Symptom: varlock couldn't load 1Password on the Mac with a token that
worked on the VM. Cause: a trailing character came along with the paste.
Found by comparing lengths and character classes without printing the
value. Fix: the README's setup step says to paste the token whole and
nothing more.

## Setting up the cloud Mac (MacStadium, macOS 27.2, 2026-11-05)

### A pasted `\n` arrived as `|n` and broke sshd

Symptom: after writing a keys-only `sshd_config.d` file with
`printf '…\n…'`, every SSH connection was reset. Cause: the backslashes
turned into `|` between the chat and Kevin's terminal, so the file was one
invalid line and sshd (started per connection on macOS) exited each time;
`sudo /usr/sbin/sshd -t` named the line. Fix: a heredoc with no
backslashes, and an SSH session kept open until a new one connects. Rule:
commands for Kevin to paste carry no backslashes.

### mosh couldn't find `mosh-server`

Symptom: "command not found: mosh-server". Cause: mosh starts the server
through a non-interactive SSH command, whose zsh reads `~/.zshenv` but not
`~/.zprofile`, where Homebrew's installer puts its PATH line. Fix:
`eval "$(/opt/homebrew/bin/brew shellenv)"` in `~/.zshenv`.

### "Keychain Not Found" on a fresh MacStadium account

Symptom: Steinberg's helper couldn't store its sign-in. Cause: the
provisioned account had no login keychain. Fix: Restore to Defaults, with
the account's current password, so auto-login unlocks it.

### MediaBay "cannot be reached" on Dorico's first launch

Symptom: right after the Local Network prompts for Dorico's components.
Fix: none needed; gone after a restart.
