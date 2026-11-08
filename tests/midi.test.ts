import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { type ExportTimeouts, exportFile } from "../src/dorico/export.js";
import { windowSummary } from "../src/dorico/import-window.js";
import { importMidi, isMidi } from "../src/dorico/midi.js";
import { connect, DORICO, FakeAx, type FakeAxOptions, IMPORT } from "./fake-ax.js";
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
const returns = (ax: FakeAx) => ax.log.filter((a) => a[0] === "keys" && a.includes("return"));
/** Presses outside `--dialogs`: there should be none. */
const unscopedPresses = (ax: FakeAx) =>
	ax.log.filter((a) => a[0] === "press" && !a.includes("--dialogs"));

describe("isMidi", () => {
	test("a Standard MIDI File starts with MThd", () => {
		expect(isMidi(MIDI)).toBe(true);
		expect(isMidi(new TextEncoder().encode(SCORE))).toBe(false);
		expect(isMidi(new Uint8Array([0x4d, 0x54, 0x68]))).toBe(false);
	});
});

describe("importMidi", () => {
	test("the window count rises by one, Return once accepts it, Dorico's MusicXML comes back", async () => {
		const { fake, ax, deps, activations, work } = await setup();
		const r = await importMidi(
			deps,
			{ name: "peaceful-dreams.mid", midi: MIDI },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.musicxml" });
		expect("importWindow" in r).toBe(false);
		const opened = fake.commandsReceived.find((c) => c.startsWith("File.Open"));
		expect(opened).toMatch(/\/in\/peaceful-dreams\.mid$/);
		// Return once, into the import window, Dorico brought forward just before it
		expect(ax.returns.filter((w) => w !== "Go to Folder")).toEqual(["import"]);
		const firstReturn = ax.log.findIndex((a) => a[0] === "keys" && a.includes("return"));
		expect(activations).toContain(firstReturn);
		// the windows counted without looking inside them (depth 0)
		for (const a of ax.log.filter((a) => a[0] === "dump" && !a.includes("--dialogs")))
			expect(a[a.indexOf("--depth") + 1]).toBe("0");
		expect(unscopedPresses(ax)).toEqual([]);
		expect(ax.log.filter((a) => a[0] === "set")).toHaveLength(1); // the export's folder path only
		expect(ax.importFile).toBeNull();
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toEqual([]);
	});

	test("mxl: the export path is the export job's", async () => {
		const { deps, work } = await setup();
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "mxl", work, FAST);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.mxl" });
	});

	test("the window never showing: an import error, no Return sent", async () => {
		const { fake, ax, deps, work } = await setup();
		fake.onMidiImport = null;
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("can't be seen through Accessibility");
			expect(r.message).toContain("1 before File.Open, 1 now");
			expect(r.message).toContain(`a ${IMPORT} window may be open on the Mac`);
			expect(r.message).toContain("Cancel it there");
		}
		expect(returns(ax)).toEqual([]);
		expect(closes(fake)).toHaveLength(0);
	});

	test("a dialog open just before Return: no Return, an import error", async () => {
		const { fake, ax, deps, work } = await setup();
		fake.onMidiImport = (file, accept) => {
			ax.showImport(file, accept);
			ax.exportOpen = true; // a dialog showed over it
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("won't send Return with these open: Export MusicXML");
		expect(returns(ax)).toEqual([]);
		expect(ax.exportOpen).toBe(false); // the failsafe cancelled the dialog
		expect(fake.projects.size).toBe(0);
	});

	test("Return not taking: sent once, never again, and the message says to Cancel it on the Mac", async () => {
		const { fake, ax, deps, work } = await setup({ returnTakes: false });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("Return didn't take or Dorico made no project");
			expect(r.message).toContain("Cancel it on the Mac");
			expect(r.message).toContain("close it without saving");
		}
		expect(returns(ax)).toHaveLength(1);
		expect(ax.returns).toEqual(["import"]);
		expect(ax.importFile).not.toBeNull();
		expect(closes(fake)).toHaveLength(0);
		expect(jobFolders(work)).toHaveLength(1); // kept for a look
	});

	test("a project appearing without the import window: fails closed, never exported or closed", async () => {
		const { fake, ax, deps, work } = await setup({}, { importsWithoutAsking: true });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain(
				"a project appeared without the MIDI Import Options window; it may not be this job's: left open, close it on the Mac without saving",
			);
		}
		expect(returns(ax)).toEqual([]);
		expect(ax.log.some((a) => a[0] === "menu")).toBe(false); // no export
		expect(closes(fake)).toEqual([]);
		expect(fake.projects.size).toBe(1);
	});

	test("a stuck import window before the job: File.Open makes nothing, no Return sent", async () => {
		const { fake, ax, deps, work } = await setup();
		ax.showImport("earlier.mid", () => {});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("2 before File.Open, 2 now");
		expect(fake.commandsReceived.some((c) => c.startsWith("File.Open"))).toBe(true);
		expect(returns(ax)).toEqual([]);
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
		expect(ax.returns.filter((w) => w !== "Go to Folder")).toEqual(["import"]);
	});

	test("a project appearing while the window waits: no Return, never taken for the import", async () => {
		const { fake, ax, deps, work } = await setup();
		const mine = join(work, "..", "mine.musicxml");
		writeFileSync(mine, SCORE);
		let kevin = -1;
		// Kevin opens a project once the job has seen the window, before it sends Return.
		ax.onRun = (a) => {
			if (kevin < 0 && ax.importFile !== null && a[0] === "dump" && a.includes("--dialogs")) {
				kevin = fake.openDirect(mine);
				fake.focus(kevin);
			}
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("a project appeared");
		expect(returns(ax)).toEqual([]);
		expect(fake.projects.has(kevin)).toBe(true);
		expect(closes(fake)).toEqual([]);
	});

	test("rejects a file that isn't MIDI before Dorico or MacBenchAX sees it", async () => {
		const { fake, ax, deps, work } = await setup();
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

	test("the .mid is written byte for byte", async () => {
		const { fake, deps, work } = await setup();
		let written = null as Uint8Array | null;
		fake.onMidiImport = (file) => {
			written = new Uint8Array(readFileSync(file));
		};
		await importMidi(deps, { name: "../odd name.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(written).toEqual(MIDI);
	});
});

describe("importMidi, once Return is sent", () => {
	test("an answer to Return that comes too late: not sent again, the project still closed", async () => {
		const { fake, ax, deps, work } = await setup();
		const run = ax.run.bind(ax);
		ax.run = async (args) => {
			const r = await run(args);
			if (args[0] === "keys" && args.includes("return") && ax.returns.at(-1) === "import")
				throw new Error("MacBenchAX gave no answer to keys within 10000 ms");
			return r;
		};
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		expect(ax.returns.filter((w) => w === "import")).toHaveLength(1);
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
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

	test("an import window it can't see: File.Open times out, and the message says why it may have", async () => {
		const { fake, ax, deps, work } = await setup();
		ax.showImport("earlier.mid", () => {});
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "open" });
		if (!r.ok)
			expect(r.message).toContain(
				`a window Accessibility can't see (such as a ${IMPORT} window) may be in the way`,
			);
		expect(fake.projects.size).toBe(0);
		expect(returns(ax)).toEqual([]);
	});
});
