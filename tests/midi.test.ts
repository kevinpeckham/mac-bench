import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { type ExportTimeouts, exportFile } from "../src/dorico/export.js";
import { importMidi, isMidi } from "../src/dorico/midi.js";
import {
	DORICO,
	FakeAx,
	type FakeAxOptions,
	GENERAL_MIDI,
	IMPORT,
	TRACK_MEMORY,
} from "./fake-ax.js";
import { FakeDorico } from "./fake-dorico.js";

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

async function setup(axOpts: FakeAxOptions = {}) {
	const fake = new FakeDorico();
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
	fake.onMidiImport = (file, accept) => ax.showImport(basename(file), accept);
	const deps = {
		dorico,
		ax,
		activate: async () => {
			ax.front = DORICO;
		},
	};
	return { fake, ax, deps, work: join(dir, "work") };
}

const closes = (fake: FakeDorico) =>
	fake.commandsReceived.filter((c) => c.startsWith("File.CloseProject"));
const jobFolders = (work: string) =>
	existsSync(join(work, "jobs")) ? readdirSync(join(work, "jobs")) : [];
/** Presses outside `--dialogs`: only ever into the import window. */
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
	test("the window's state is recorded, OK accepted, Dorico's MusicXML export comes back", async () => {
		const { fake, ax, deps, work } = await setup();
		const r = await importMidi(
			deps,
			{ name: "peaceful-dreams.mid", midi: MIDI },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.musicxml" });
		expect(r.importWindow).toEqual({
			file: "peaceful-dreams.mid",
			useTrackMemory: true,
			interpretAsGeneralMidi: true,
			columns: [
				"#",
				"",
				"MIDI track name",
				"",
				"Instrument(s) in track",
				"Technique(s)",
				"Family",
				"Destination instrument",
				"Max. sim. notes",
				"Total no. of notes",
			],
			tracks: [
				{
					enabled: true,
					cells: ["1", "", "Chart", "", "Treble staff", "", "Sketch", "Treble staff 1", "5", "583"],
					name: "Chart",
					instrument: "Treble staff",
					technique: "",
					family: "Sketch",
					destination: "Treble staff 1",
					maxNotes: 5,
					notes: 583,
				},
			],
		});
		// the .mid went to Dorico as it was
		const opened = fake.commandsReceived.find((c) => c.startsWith("File.Open"));
		expect(opened).toMatch(/\/in\/peaceful-dreams\.mid$/);
		// OK pressed once, only in the import window; nothing typed or changed in it
		const presses = unscopedPresses(ax);
		expect(presses).toEqual([["press", "--title", "OK", "--role", "AXButton", "--after", IMPORT]]);
		expect(ax.importBoxes).toEqual({ [TRACK_MEMORY]: 1, [GENERAL_MIDI]: 1 });
		expect(ax.log.filter((a) => a[0] === "set")).toHaveLength(1); // the export's folder path only
		expect(ax.decoysPressed).toEqual([]);
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

	test("several tracks, one disabled, are all recorded", async () => {
		const { deps, work } = await setup({
			importTracks: [
				{
					name: "Piano",
					instrument: "Piano",
					family: "Keyboards",
					destination: "Piano 1",
					maxNotes: 4,
					notes: 100,
				},
				{
					name: "Bass",
					instrument: "Acoustic Bass",
					technique: "pizz.",
					family: "Strings",
					destination: "Bass 1",
					maxNotes: 1,
					notes: 32,
					enabled: false,
				},
			],
		});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(
			r.importWindow?.tracks.map((t) => [t.name, t.instrument, t.technique, t.enabled, t.notes]),
		).toEqual([
			["Piano", "Piano", "", true, 100],
			["Bass", "Acoustic Bass", "pizz.", false, 32],
		]);
	});

	test("the import window listed behind the document: OK still lands in it", async () => {
		const { ax, deps, work } = await setup({ importBehind: true });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(ax.decoysPressed).toEqual([]);
	});

	test("an OK deeper than a press looks: not pressed, the decoys untouched, the window cancelled", async () => {
		const { fake, ax, deps, work } = await setup({ importButtonsDeep: true });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) expect(r.message).toContain("won't press OK");
		expect(ax.log.some((a) => a[0] === "press" && a.includes("OK"))).toBe(false);
		expect(ax.decoysPressed).toEqual([]);
		expect(ax.importFile).toBeNull(); // Escape closed it
		expect(fake.projects.size).toBe(0);
	});

	test("OK not taking: an import error naming the windows seen; the failsafe cancels it", async () => {
		const { fake, ax, deps, work } = await setup({ importOkTakes: false });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain("OK didn't take");
			expect(r.message).toContain(`AXWindow/AXStandardWindow "${IMPORT}"`);
			expect(r.message).not.toContain("left open");
		}
		expect(r.importWindow?.tracks).toHaveLength(1); // recorded all the same
		const cancel = unscopedPresses(ax).find((a) => a.includes("Cancel"));
		expect(cancel).toEqual(["press", "--title", "Cancel", "--role", "AXButton", "--after", IMPORT]);
		expect(ax.importFile).toBeNull();
		expect(ax.decoysPressed).toEqual([]);
		expect(closes(fake)).toHaveLength(0);
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toHaveLength(1); // kept for a look
	});

	test("the window never showing: an import error naming the windows seen", async () => {
		const { fake, ax, deps, work } = await setup();
		fake.onMidiImport = null;
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain(`${IMPORT} window didn't show`);
			expect(r.message).toContain('AXWindow/AXStandardWindow "Hymn - Full score"');
		}
		expect(ax.log.some((a) => a[0] === "press")).toBe(false);
	});

	test("a stuck import window at the start: refused before opening anything", async () => {
		const { fake, ax, deps, work } = await setup();
		ax.showImport("earlier.mid", () => {});
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "preflight" });
		if (!r.ok) expect(r.message).toContain(`a dialog is already open in Dorico: ${IMPORT}`);
		expect(fake.commandsReceived).toEqual([]);
		expect(ax.log.some((a) => a[0] === "press" || a[0] === "dismiss")).toBe(false);
		expect(ax.importFile).toBe("earlier.mid"); // not ours to cancel
	});

	test("an import window that won't close: named, project never made, nothing pressed elsewhere", async () => {
		const { fake, ax, deps, work } = await setup({ importOkTakes: false, importStuck: true });
		const r = await importMidi(deps, { name: "a.mid", midi: MIDI }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "import" });
		if (!r.ok) {
			expect(r.message).toContain(`a Dorico dialog is still open: ${IMPORT}`);
			expect(r.message).toContain("screen sharing");
		}
		expect(ax.log.filter((a) => a[0] === "keys" && a.includes("escape")).length).toBeGreaterThan(0);
		expect(ax.decoysPressed).toEqual([]);
		expect(fake.projects.size).toBe(0);
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

describe("the import window, for the MusicXML export job", () => {
	test("counts as a dialog at preflight", async () => {
		const { fake, ax, deps, work } = await setup();
		ax.showImport("earlier.mid", () => {});
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "preflight" });
		if (!r.ok) expect(r.message).toContain(IMPORT);
		expect(fake.commandsReceived).toEqual([]);
	});

	test("blocks OK in Export MusicXML if it shows mid-job, and the failsafe cancels it", async () => {
		const { ax, deps, work } = await setup();
		ax.onRun = (a) => {
			if (a[0] === "press" && a.includes("Choose")) ax.showImport("stray.mid", () => {});
		};
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "export" });
		if (!r.ok)
			expect(r.message).toContain(`won't press OK with these open: Export MusicXML, ${IMPORT}`);
		expect(ax.importFile).toBeNull();
		expect(ax.decoysPressed).toEqual([]);
	});
});
