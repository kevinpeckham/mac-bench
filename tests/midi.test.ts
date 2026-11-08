import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxNoAnswer } from "../src/ax/client.js";
import { DoricoClient } from "../src/dorico/client.js";
import { type ExportTimeouts, exportFile } from "../src/dorico/export.js";
import { windowSummary } from "../src/dorico/import-window.js";
import { importMidi, isMidi } from "../src/dorico/midi.js";
import {
	connect,
	DORICO,
	FakeAx,
	type FakeAxOptions,
	GENERAL_MIDI,
	HUB,
	IMPORT,
	type Shape,
	TRACK_MEMORY,
} from "./fake-ax.js";
import { FakeDorico, type FakeOptions } from "./fake-dorico.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanup.splice(0)) f();
});

const FAST: ExportTimeouts = {
	openMs: 400,
	exportMs: 400,
	closeMs: 400,
	dialogMs: 300,
	settleMs: 1,
	pollMs: 5,
};

/** A minimal Standard MIDI File: the header and one empty track, with bytes no text survives. */
const MIDI = new Uint8Array([
	...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0],
	...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0],
]);
const SCORE = `<score-partwise version="4.0"><work><work-title>Hymn</work-title></work></score-partwise>`;

/** Dorico's state for each shape: only the Hub (dialog), or a project window open (opaque). */
const STATE: Record<Shape, FakeAxOptions> = {
	dialog: { projectWindows: 0 },
	opaque: { projectWindows: 1 },
};
const SHAPES: Shape[] = ["dialog", "opaque"];

async function setup(axOpts: FakeAxOptions = {}, doricoOpts: FakeOptions = {}) {
	const fake = new FakeDorico(doricoOpts);
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-midi-"));
	writeFileSync(join(dir, "token"), "known-token");
	const dorico = new DoricoClient({
		url: fake.url,
		tokenPath: join(dir, "token"),
		clientName: "mac-bench",
		retryMs: 50,
	});
	dorico.start();
	cleanup.push(() => {
		dorico.stop();
		fake.stop();
	});
	const end = Date.now() + 2000;
	while (dorico.state !== "connected" && Date.now() < end) await Bun.sleep(10);
	const ax = new FakeAx(axOpts);
	connect(fake, ax);
	const activations: number[] = [];
	const deps = {
		dorico,
		ax,
		activate: async () => {
			activations.push(ax.log.length);
			ax.front = DORICO;
		},
	};
	return { fake, ax, deps, activations, work: join(dir, "work") };
}

const closes = (fake: FakeDorico) =>
	fake.commandsReceived.filter((c) => c.startsWith("File.CloseProject"));
const jobFolders = (work: string) =>
	existsSync(join(work, "jobs")) ? readdirSync(join(work, "jobs")) : [];
/** Returns sent while the import window was up (the export's Go to Folder Return aside). */
const importReturns = (ax: FakeAx) => ax.returns.filter((w) => w !== "Go to Folder");
const okPresses = (ax: FakeAx) =>
	ax.log.filter((a) => a[0] === "press" && a.includes("OK") && ax.log.indexOf(a) < firstMenu(ax));
const firstMenu = (ax: FakeAx) => {
	const i = ax.log.findIndex((a) => a[0] === "menu");
	return i < 0 ? ax.log.length : i;
};
/** Presses outside `--dialogs`: there should be none. */
const unscopedPresses = (ax: FakeAx) =>
	ax.log.filter((a) => a[0] === "press" && !a.includes("--dialogs"));
/** Kevin opens a project of his own, in front. */
function kevinOpens(fake: FakeDorico, work: string): number {
	const mine = join(work, "..", "mine.musicxml");
	writeFileSync(mine, SCORE);
	const id = fake.openDirect(mine);
	fake.focus(id);
	return id;
}

describe("isMidi", () => {
	test("a Standard MIDI File starts with MThd", () => {
		expect(isMidi(MIDI)).toBe(true);
		expect(isMidi(new TextEncoder().encode(SCORE))).toBe(false);
		expect(isMidi(new Uint8Array([0x4d, 0x54, 0x68]))).toBe(false);
	});
});

describe("the fakes", () => {
	test("Hub only: the import window is a readable dialog; a project window makes Dorico opaque", () => {
		const ax = new FakeAx(STATE.dialog);
		expect(ax.windows().map((w) => [w.AXRole, w.AXSubrole, w.AXTitle])).toEqual([
			["AXWindow", "AXStandardWindow", HUB],
		]);
		ax.showImport("a.mid", () => ax.openProjectWindow());
		expect(ax.windows()[0]).toMatchObject({ AXSubrole: "AXDialog", AXTitle: IMPORT });
		ax.openProjectWindow();
		expect(ax.windows().map((w) => w.AXRole)).toEqual(["AXApplication", "AXApplication"]);
	});

	test("Return with Export MusicXML up presses its OK, as live", async () => {
		const ax = new FakeAx({ writesFile: false });
		ax.exportOpen = true;
		ax.front = DORICO;
		await ax.run(["keys", "--combo", "return"]);
		expect(ax.exportOpen).toBe(false);
		expect(ax.returns).toEqual(["Export MusicXML"]);
	});

	test("opaque: accepting goes N+1 to N to N+1 windows, as live", async () => {
		const { fake, ax, deps } = await setup(STATE.opaque);
		const standard = () => ax.windows().filter((w) => w.AXSubrole !== "AXDialog").length;
		const counts = [standard()];
		ax.showImport("a.mid", () => setTimeout(() => fake.openDirect("x.mid"), 10));
		counts.push(standard());
		await deps.activate();
		await ax.run(["keys", "--combo", "return"]);
		counts.push(standard());
		ax.openProjectWindow(); // as connect does when Dorico announces the project
		counts.push(standard());
		expect(counts).toEqual([1, 2, 1, 2]);
	});
});

describe.each(SHAPES)("importMidi, %s shape", (shape) => {
	test("the window shows, is accepted once, and Dorico's MusicXML comes back", async () => {
		const { fake, ax, deps, activations, work } = await setup(STATE[shape]);
		const r = await importMidi(
			deps,
			{ name: "peaceful-dreams.mid", midi: MIDI },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.musicxml" });
		const opened = fake.commandsReceived.find((c) => c.startsWith("File.Open"));
		expect(opened).toMatch(/\/in\/peaceful-dreams\.mid$/);
		if (shape === "dialog") {
			// read, then OK pressed once, scoped to dialogs; no Return into it
			expect(r).toMatchObject({
				importWindow: {
					file: "peaceful-dreams.mid",
					useTrackMemory: true,
					interpretAsGeneralMidi: true,
					tracks: [
						{
							enabled: true,
							name: "Chart",
							instrument: "Treble staff",
							family: "Sketch",
							destination: "Treble staff 1",
							maxNotes: 5,
							notes: 583,
						},
					],
				},
			});
			expect(okPresses(ax)).toEqual([
				["press", "--dialogs", "--title", "OK", "--role", "AXButton", "--after", IMPORT],
			]);
			// the window's raw tree, for checking the fake against the real thing
			expect(r.importWindow?.raw).toMatchObject({ AXSubrole: "AXDialog", AXTitle: IMPORT });
			const raw = JSON.stringify(r.importWindow?.raw);
			for (const t of ["AXGrowArea", "AXTable", TRACK_MEMORY, "Treble staff 1", '"OK"'])
				expect(raw).toContain(t);
			expect(importReturns(ax)).toEqual([]);
		} else {
			expect("importWindow" in r).toBe(false);
			expect(okPresses(ax)).toEqual([]);
			expect(importReturns(ax)).toEqual(["import"]);
			const firstReturn = ax.log.findIndex((a) => a[0] === "keys" && a.includes("return"));
			expect(activations).toContain(firstReturn);
		}
		// Dorico's whole window list is only ever dumped with no depth
		for (const a of ax.log.filter((a) => a[0] === "dump" && !a.includes("--dialogs")))
			expect(a[a.indexOf("--depth") + 1]).toBe("0");
		expect(unscopedPresses(ax)).toEqual([]);
		expect(ax.importBoxes).toEqual({ [TRACK_MEMORY]: 1, [GENERAL_MIDI]: 1 });
		expect(ax.log.filter((a) => a[0] === "set")).toHaveLength(1); // the export's folder path only
		expect(ax.importFile).toBeNull();
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toEqual([]);
	});

	test("mxl: the export path is the export job's", async () => {
		const { deps, work } = await setup(STATE[shape]);
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "mxl", work, FAST);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.mxl" });
	});

	test("the window never showing: an import error, nothing sent into it", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		fake.onMidiImport = null;
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain(`${IMPORT} window didn't show`);
			expect(r.message).toContain("1 before File.Open, 1 now");
			expect(r.message).toContain("Cancel it there");
		}
		expect(importReturns(ax)).toEqual([]);
		expect(okPresses(ax)).toEqual([]);
		expect(closes(fake)).toHaveLength(0);
	});

	test("another dialog open beside it: not accepted, an import error", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		fake.onMidiImport = (file, accept) => {
			ax.showImport(file, accept);
			ax.exportOpen = true; // a dialog showed with it
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok)
			expect(r.message).toContain(
				shape === "dialog"
					? `won't press OK with these open: ${IMPORT}, Export MusicXML`
					: "won't send Return with these open: Export MusicXML",
			);
		expect(importReturns(ax)).toEqual([]);
		expect(okPresses(ax)).toEqual([]);
		expect(ax.exportOpen).toBe(false); // the failsafe cancelled the dialog
		expect(fake.projects.size).toBe(0);
	});

	test("N+1 windows and a newer score together: nothing sent, fails closed, never exported or closed", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape], { importsWithoutAsking: true });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok)
			expect(r.message).toContain(
				"a project appeared without the MIDI Import Options window; it may not be this job's: left open, close it on the Mac without saving",
			);
		expect(importReturns(ax)).toEqual([]);
		expect(okPresses(ax)).toEqual([]);
		expect(ax.log.some((a) => a[0] === "menu")).toBe(false); // no export
		expect(closes(fake)).toEqual([]);
		expect(fake.projects.size).toBe(1);
	});

	test("a project appearing once the window has shown: nothing sent, never taken for the import", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		let kevin = -1;
		// Kevin opens a project once the job has seen the window, before it accepts it.
		ax.onRun = (a) => {
			if (kevin < 0 && ax.importFile !== null && a[0] === "dump" && a.includes("--dialogs"))
				kevin = kevinOpens(fake, work);
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("a project appeared");
		expect(importReturns(ax)).toEqual([]);
		expect(okPresses(ax)).toEqual([]);
		expect(fake.projects.has(kevin)).toBe(true);
		expect(closes(fake)).toEqual([]);
	});

	test("an answer that comes too late: not sent again, the project still closed", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		const run = ax.run.bind(ax);
		const accepting = (a: string[]) =>
			(a[0] === "keys" && a.includes("return") && ax.returns.at(-1) === "import") ||
			(a[0] === "press" && a.includes("OK") && ax.log.filter((x) => x[0] === "menu").length === 0);
		ax.run = async (args) => {
			const r = await run(args);
			if (accepting(args)) throw new AxNoAnswer("MacBenchAX gave no answer within 10000 ms");
			return r;
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		expect(importReturns(ax).length + okPresses(ax).length).toBe(1);
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
	});

	test("a definite refusal: fails at once, and a project that then appears is never closed", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		const run = ax.run.bind(ax);
		let kevin = -1;
		ax.run = async (args) => {
			const accepting =
				(args[0] === "keys" && args.includes("return") && ax.importFile !== null) ||
				(args[0] === "press" && args.includes("OK") && ax.importFile !== null);
			if (!accepting) return run(args);
			ax.log.push(args);
			kevin = kevinOpens(fake, work);
			return { error: "the frontmost app isn't one MacBenchAX may type into" };
		};
		const started = Date.now();
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("the frontmost app isn't one MacBenchAX may type into");
			if (shape === "dialog") {
				expect(r.message).toContain("the failsafe cancels the window");
				expect(r.message).not.toContain("Cancel it there");
			} else expect(r.message).toContain("Cancel it there");
		}
		expect(fake.projects.has(kevin)).toBe(true);
		expect(closes(fake)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(FAST.openMs + 300); // no wait for a project
	});

	test("a slow MacBenchAX: the project after acceptance is still waited for", async () => {
		const { ax, deps, work } = await setup(STATE[shape]);
		const run = ax.run.bind(ax);
		let accepted = false;
		ax.run = async (args) => {
			if (!accepted) await Bun.sleep(300); // each call slow, until the window is accepted
			const r = await run(args);
			if (args[0] === "keys" || (args[0] === "press" && args.includes("OK"))) accepted = true;
			return r;
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: true });
	});

	test("rejects a file that isn't MIDI before Dorico or MacBenchAX sees it", async () => {
		const { fake, ax, deps, work } = await setup(STATE[shape]);
		const r = await importMidi(
			deps,
			{ name: "a.mid", midi: new TextEncoder().encode(SCORE) },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: false, step: "check" });
		if (!r.ok) expect(r.message).toContain("MThd");
		expect(fake.commandsReceived).toEqual([]);
		expect(ax.log).toEqual([]);
		expect(jobFolders(work)).toEqual([]);
	});
});

describe("importMidi, dialog shape", () => {
	test("OK not taking: an import error, the failsafe cancels the window, a project then appearing is never closed", async () => {
		const { fake, ax, deps, work } = await setup({ ...STATE.dialog, importOkTakes: false });
		let kevin = -1;
		ax.onRun = (a) => {
			if (kevin < 0 && a[0] === "press" && a.includes("OK")) kevin = kevinOpens(fake, work);
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("OK didn't take");
			expect(r.message).toContain("close it without saving");
			expect(r.message).not.toContain("still open: ");
		}
		expect(fake.projects.has(kevin)).toBe(true);
		expect(r.importWindow?.tracks).toHaveLength(1); // recorded all the same
		expect(okPresses(ax)).toHaveLength(1);
		expect(ax.log.some((a) => a[0] === "dismiss")).toBe(true);
		expect(ax.importFile).toBeNull();
		expect(closes(fake)).toHaveLength(0);
	});

	test("a second dialog with its own OK, listed first, showing just before the press: the import's OK is pressed", async () => {
		const { ax, deps, work } = await setup({ ...STATE.dialog, writesFile: false });
		ax.onRun = (a) => {
			if (a[0] === "press" && a.includes("OK") && ax.importFile !== null) {
				ax.importBehind = true;
				ax.exportOpen = true;
			}
		};
		await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(ax.okPressed[0]).toBe(IMPORT);
		expect(ax.okPressed).not.toContain("Export MusicXML");
	});

	test("OK answered ok: false (AXPress errored): nothing recorded, the message says to close a later project", async () => {
		const { fake, ax, deps, work } = await setup(STATE.dialog);
		const run = ax.run.bind(ax);
		ax.run = async (args) => {
			const r = await run(args);
			return args[0] === "press" && args.includes("OK") && ax.okPressed.length === 1
				? { ...r, ok: false }
				: r;
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("OK may have acted");
			expect(r.message).toContain("close it without saving");
		}
		expect(closes(fake)).toEqual([]); // the project the press made is left for Kevin
	});

	test("a leftover import dialog: refused at preflight, not cancelled", async () => {
		const { fake, ax, deps, work } = await setup(STATE.dialog);
		ax.showImport("earlier.mid", () => {});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "preflight" });
		if (!r.ok) expect(r.message).toContain(`a dialog is already open in Dorico: ${IMPORT}`);
		expect(fake.commandsReceived).toEqual([]);
		expect(ax.log.some((a) => a[0] === "press" || a[0] === "dismiss")).toBe(false);
		expect(ax.importFile).toBe("earlier.mid");
	});

	test("several tracks, one disabled, are all recorded", async () => {
		const { deps, work } = await setup({
			...STATE.dialog,
			importTracks: [
				{
					name: "Voice",
					instrument: "Voice",
					family: "Vocal",
					destination: "Voice 1",
					maxNotes: 1,
					notes: 100,
				},
				{
					name: "Acoustic Guitar",
					instrument: "Acoustic Guitar",
					technique: "pizz.",
					family: "Plucked strings",
					destination: "Acoustic Guitar 1",
					maxNotes: 4,
					notes: 32,
					enabled: false,
				},
			],
		});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(
			r.importWindow?.tracks.map((t) => [t.name, t.destination, t.technique, t.enabled, t.notes]),
		).toEqual([
			["Voice", "Voice 1", "", true, 100],
			["Acoustic Guitar", "Acoustic Guitar 1", "pizz.", false, 32],
		]);
	});

	test("a titled dialog with a project window open is still read and pressed, not counted", async () => {
		const { ax, deps, work } = await setup({ projectWindows: 1, importShape: "dialog" });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(okPresses(ax)).toHaveLength(1);
		expect(importReturns(ax)).toEqual([]);
	});
});

describe("importMidi, opaque shape", () => {
	test("Return not taking: sent once, never again, and the message says to Cancel it on the Mac", async () => {
		const { fake, ax, deps, work } = await setup({ ...STATE.opaque, returnTakes: false });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("Return didn't take or Dorico made no project");
			expect(r.message).toContain("Cancel it on the Mac");
			expect(r.message).toContain("close it without saving");
		}
		expect(ax.returns).toEqual(["import"]);
		expect(ax.importFile).not.toBeNull();
		expect(closes(fake)).toHaveLength(0);
		expect(jobFolders(work)).toHaveLength(1); // kept for a look
	});

	test("Dorico not brought forward: no Return, nothing waited for or recorded", async () => {
		const { fake, ax, deps, work } = await setup(STATE.opaque);
		let kevin = -1;
		const failing = {
			...deps,
			activate: async () => {
				kevin = kevinOpens(fake, work);
				throw new Error("couldn't bring Dorico to the front");
			},
		};
		const r = await importMidi(failing, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("couldn't bring Dorico to the front");
		expect(ax.log.some((a) => a[0] === "keys")).toBe(false);
		expect(fake.projects.has(kevin)).toBe(true);
		expect(closes(fake)).toEqual([]);
	});

	test("a stuck import window before the job: File.Open makes nothing, no Return sent", async () => {
		const { fake, ax, deps, work } = await setup(STATE.opaque);
		ax.showImport("earlier.mid", () => {});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("2 before File.Open, 2 now");
		expect(fake.commandsReceived.some((c) => c.startsWith("File.Open"))).toBe(true);
		expect(ax.returns).toEqual([]);
		expect(ax.importFile).toBe("earlier.mid"); // not ours to touch
	});

	test("project windows already open: Return only once the count rises by one", async () => {
		const { fake, ax, deps, work } = await setup({ projectWindows: 2 });
		const show = fake.onMidiImport;
		fake.onMidiImport = (file, accept) => setTimeout(() => show?.(file, accept), 100);
		const at: number[] = [];
		ax.onRun = (a) => {
			if (a[0] === "keys" && a.includes("return") && ax.importFile !== null)
				at.push(ax.windows().length);
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(at).toEqual([3]);
		expect(importReturns(ax)).toEqual(["import"]);
	});
});

describe("windowSummary", () => {
	test("Dorico's self-similar standard windows: short and finite", async () => {
		const ax = new FakeAx({ projectWindows: 4 });
		ax.showImport("a.mid", () => {});
		ax.exportOpen = true;
		const s = await windowSummary(ax);
		expect(s).toContain("window (opaque to Accessibility)");
		expect(s).toContain('AXWindow/AXDialog "Export MusicXML"');
		expect(s.length).toBeLessThan(600);
		for (const a of ax.log.filter((a) => a[0] === "dump"))
			expect(Number(a[a.indexOf("--depth") + 1])).toBeLessThanOrEqual(1);
	});
});

describe("the MusicXML export job, beside an import window", () => {
	test("its preflight looks only at dialogs, sheets and menus", async () => {
		const { ax, deps, work } = await setup();
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		for (const a of ax.log.filter((a) => a[0] === "dump")) expect(a).toContain("--dialogs");
	});

	test("an opaque import window it can't see: File.Open times out, and the message says why it may have", async () => {
		const { fake, ax, deps, work } = await setup(STATE.opaque);
		ax.showImport("earlier.mid", () => {});
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "open" });
		if (!r.ok)
			expect(r.message).toContain(
				`a window Accessibility can't see (such as a ${IMPORT} window) may be in the way`,
			);
		expect(fake.projects.size).toBe(0);
		expect(ax.returns).toEqual([]);
	});

	test("a readable import dialog: refused at preflight like any dialog", async () => {
		const { fake, ax, deps, work } = await setup(STATE.dialog);
		ax.showImport("earlier.mid", () => {});
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "preflight" });
		if (!r.ok) expect(r.message).toContain(IMPORT);
		expect(fake.commandsReceived).toEqual([]);
	});
});
