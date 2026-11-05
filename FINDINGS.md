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
