import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoricoClient } from "../src/dorico/client.js";
import { type ExportTimeouts, exportFile } from "../src/dorico/export.js";
import { DORICO, FakeAx, type FakeAxOptions, FOLDER, MXL, SEPARATE, XML } from "./fake-ax.js";
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
const SCORE = `<?xml version="1.0"?>\n<score-partwise version="4.0"><work><work-title>Hymn</work-title></work></score-partwise>\n`;

async function setup(axOpts: FakeAxOptions = {}) {
	const fake = new FakeDorico();
	const dir = mkdtempSync(join(tmpdir(), "mac-bench-export-"));
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

const jobFolders = (work: string) =>
	existsSync(join(work, "jobs")) ? readdirSync(join(work, "jobs")) : [];
const closes = (fake: FakeDorico) =>
	fake.commandsReceived.filter((c) => c.startsWith("File.CloseProject"));
const commands = (ax: FakeAx) => ax.log.filter((a) => a[0] !== "dump");

describe("exportFile", () => {
	test("musicxml: the full score's file comes back, only the needed boxes toggled", async () => {
		const { fake, ax, deps, activations, work } = await setup();
		const r = await exportFile(deps, { name: "hymn.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.musicxml" });
		if (r.ok) expect(new TextDecoder().decode(r.file)).toStartWith("fake .musicxml");
		// .musicxml was already on and .mxl off: only these two needed pressing
		expect(ax.toggled).toEqual([FOLDER, SEPARATE]);
		expect(ax.boxes).toMatchObject({ [MXL]: 0, [XML]: 1, [SEPARATE]: 0, [FOLDER]: 0 });
		// Dorico brought forward before the first keystroke (before the menu, in fact)
		const menuAt = ax.log.findIndex((a) => a[0] === "menu");
		expect(activations[0]).toBeLessThanOrEqual(menuAt);
		// only the folder path is ever typed
		expect(ax.log.filter((a) => a[0] === "set")).toHaveLength(1);
		expect(ax.log.find((a) => a[0] === "set")?.at(-1)).toMatch(/\/out\/$/);
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toEqual([]);
	});

	test("mxl: turns .mxl on first, then .musicxml off", async () => {
		const { ax, deps, work } = await setup({ initial: { [SEPARATE]: 0, [FOLDER]: 0 } });
		const r = await exportFile(deps, { name: "hymn.musicxml", xml: SCORE }, "mxl", work, FAST);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.mxl" });
		expect(ax.toggled).toEqual([MXL, XML]);
	});

	test("nothing toggled when the dialog is already as wanted", async () => {
		const { ax, deps, work } = await setup({ initial: { [SEPARATE]: 0, [FOLDER]: 0 } });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(ax.toggled).toEqual([]);
	});

	test("Full score is turned on if it was off; other layouts are left as they are", async () => {
		const { ax, deps, work } = await setup({ initial: { "Full score": 0, "01_Voice": 1 } });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(ax.toggled).toContain("Full score");
		expect(ax.toggled).not.toContain("01_Voice");
	});

	test("Dorico writing one file per layout anyway: the Full score one is taken", async () => {
		const { deps, work } = await setup({ alwaysSeparate: true });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: true, exported: "Hymn - Full score - 01 Hymn.musicxml" });
	});

	test("no flow selected: stops at options, cancels the dialog, closes the project", async () => {
		const { fake, ax, deps, work } = await setup({ initial: { Hymn: 0 } });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "options" });
		if (!r.ok) expect(r.message).toContain("flow");
		expect(ax.exportOpen).toBe(false);
		expect(ax.log.some((a) => a.includes("OK"))).toBe(false);
		expect(closes(fake)).toHaveLength(1);
	});

	test("a checkbox that won't take: stops at options", async () => {
		const { ax, deps, work } = await setup();
		const press = ax.run.bind(ax);
		ax.run = async (a) => {
			const r = await press(a);
			if (a[0] === "press" && a.includes(FOLDER)) ax.boxes[FOLDER] = 1; // flips back on
			return r;
		};
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "options" });
		if (!r.ok) expect(r.message).toContain(FOLDER);
	});

	test("the dialog never appears: a dialog error, the failsafe runs, the project is closed", async () => {
		const { fake, ax, deps, work } = await setup({ dialogAppears: false });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "dialog" });
		if (!r.ok) {
			expect(r.message).toContain("Export MusicXML");
			expect(r.message).not.toContain("left open");
		}
		expect(ax.log.filter((a) => a[0] === "dump").at(-1)).toBeDefined();
		expect(closes(fake)).toHaveLength(1);
		expect(fake.projects.size).toBe(0);
		expect(jobFolders(work)).toHaveLength(1); // kept for a look
	});

	test("the folder doesn't take: a folder error, both dialogs cancelled, nothing exported", async () => {
		const { fake, ax, deps, work } = await setup({ folderTakes: false });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "folder" });
		if (!r.ok) expect(r.message).toContain("Dorico Projects");
		expect(ax.log.some((a) => a[0] === "press" && a.includes("Choose"))).toBe(false);
		expect(ax.log.some((a) => a[0] === "press" && a.includes("OK"))).toBe(false);
		expect(ax.log.some((a) => a[0] === "dismiss")).toBe(true);
		expect([ax.exportOpen, ax.openPanel, ax.sheet]).toEqual([false, false, false]);
		expect(closes(fake)).toHaveLength(1);
	});

	test("no file within the time limit: an export error, project closed", async () => {
		const { fake, deps, work } = await setup({ writesFile: false });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "export" });
		if (!r.ok) expect(r.message).toContain(".musicxml");
		expect(closes(fake)).toHaveLength(1);
	});

	test("a dialog the failsafe can't close: named, escape tried, project left open", async () => {
		const { fake, ax, deps, work } = await setup({ folderTakes: false, stuck: "Open" });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "folder" });
		if (!r.ok) {
			expect(r.message).toContain("a Dorico dialog is still open: Export MusicXML, Open");
			expect(r.message).toContain("screen sharing");
			expect(r.message).toContain("left open");
		}
		expect(ax.log.filter((a) => a[0] === "dismiss")).toHaveLength(4);
		expect(ax.log.filter((a) => a[0] === "keys" && a.includes("escape")).length).toBeGreaterThan(0);
		expect(closes(fake)).toHaveLength(0);
	});

	test("a dialog left over after a good export fails the job, naming it", async () => {
		const { fake, ax, deps, work } = await setup({ stuck: "Export MusicXML" });
		const run = ax.run.bind(ax);
		ax.run = async (a) => {
			const r = await run(a);
			if (a[0] === "press" && a.includes("OK")) ax.exportOpen = true; // and it won't go
			return r;
		};
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "failsafe" });
		if (!r.ok) expect(r.message).toContain("still open: Export MusicXML");
		expect(closes(fake)).toHaveLength(0);
	});

	test("not trusted: a clear error before anything is opened", async () => {
		const { fake, ax, deps, work } = await setup({ trusted: false });
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "ax" });
		if (!r.ok) expect(r.message).toContain("Accessibility");
		expect(fake.commandsReceived).toEqual([]);
		expect(commands(ax)).toEqual([["trusted"]]);
		expect(jobFolders(work)).toEqual([]);
	});

	test("MacBenchAX not answering: an ax error before anything is opened", async () => {
		const { fake, deps, work } = await setup();
		const r = await exportFile(
			{
				...deps,
				ax: {
					run: async () => {
						throw new Error("MacBenchAX gave no answer to trusted within 10000 ms");
					},
				},
			},
			{ name: "h.musicxml", xml: SCORE },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: false, step: "ax" });
		expect(fake.commandsReceived).toEqual([]);
	});

	test("rejects non-MusicXML before Dorico or MacBenchAX sees it", async () => {
		const { fake, ax, deps, work } = await setup();
		const r = await exportFile(deps, { name: "x.txt", xml: "hello" }, "mxl", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "check" });
		expect(fake.commandsReceived).toEqual([]);
		expect(ax.log).toEqual([]);
	});

	test("another project in front: stops at focus before any menu, and closes nothing", async () => {
		const { fake, ax, deps, work } = await setup();
		const mine = join(work, "..", "mine.musicxml");
		writeFileSync(mine, SCORE);
		const kevin = fake.openDirect(mine);
		fake.onOpened = () => fake.focus(kevin);
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r).toMatchObject({ ok: false, step: "focus" });
		expect(ax.log.some((a) => a[0] === "menu")).toBe(false);
		expect(closes(fake)).toHaveLength(0);
		expect(fake.projects.has(kevin)).toBe(true);
	});

	test("Dorico not frontmost (or losing it): the key step fails, the failsafe still tidies", async () => {
		const { fake, ax, deps, work } = await setup();
		const r = await exportFile(
			{ ...deps, activate: async () => {} },
			{ name: "h.musicxml", xml: SCORE },
			"musicxml",
			work,
			FAST,
		);
		expect(r).toMatchObject({ ok: false, step: "folder" });
		if (!r.ok) expect(r.message).toContain("frontmost");
		expect([ax.exportOpen, ax.openPanel]).toEqual([false, false]);
		expect(closes(fake)).toHaveLength(1);
	});

	test("Dorico is brought forward before every key step", async () => {
		const { ax, deps, work } = await setup();
		ax.onRun = (a) => {
			if (a[0] === "keys") expect(ax.front).toBe(DORICO);
			else if (a[0] !== "dump") ax.front = "com.apple.finder"; // something else comes forward
		};
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
	});

	test("OK is pressed only when Export MusicXML is the one dialog open", async () => {
		const { ax, deps, work } = await setup();
		const pressedOkWith: string[][] = [];
		ax.onRun = (a) => {
			if (a[0] === "press" && a.includes("OK"))
				pressedOkWith.push(ax.windows().map((w) => w.AXTitle ?? ""));
		};
		const r = await exportFile(deps, { name: "h.musicxml", xml: SCORE }, "musicxml", work, FAST);
		expect(r.ok).toBe(true);
		expect(pressedOkWith).toEqual([["Hymn - Full score", "Export MusicXML"]]);
	});
});
