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
