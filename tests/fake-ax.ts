/**
 * A fake MacBenchAX for tests: Dorico's windows as state, answering the
 * commands `ax/main.swift` takes the way the spike (2026-11-07) saw the real
 * ones answer. The Export MusicXML dialog has the checkboxes Dorico 6.2
 * shows, in the order its dump lists them; its folder button (titled with a
 * private-use glyph) opens a standard Open panel; Cmd-Shift-G there opens a
 * sheet with one text field, and Return in it moves the panel to the typed
 * folder. OK writes the export into the chosen folder the way Dorico does
 * (a "Flows from …" folder and one file per layout, unless told otherwise).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AxClient } from "../src/ax/client.js";

export type AxNode = {
	AXRole: string;
	AXSubrole?: string;
	AXTitle?: string;
	AXValue?: string | number;
	AXIdentifier?: string;
	children?: AxNode[];
};

export const DORICO = "com.steinberg.dorico6";
export const GLYPH = "";
export const MXL = "Export compressed XML (.mxl)";
export const XML = "Export uncompressed XML (.musicxml)";
export const SEPARATE = "Export layouts as separate files";
export const FOLDER = "Create folder for exported files";

export type FakeAxOptions = {
	trusted?: boolean;
	/** The project's title, for the exported file names. */
	title?: string;
	/** Whether File > Export > MusicXML... opens the dialog. */
	dialogAppears?: boolean;
	/** Whether Return in the Go to Folder sheet moves the Open panel there. */
	folderTakes?: boolean;
	/** Whether OK writes anything. */
	writesFile?: boolean;
	/** Write one file per layout even with "separate files" off. */
	alwaysSeparate?: boolean;
	/** A dialog title neither Cancel nor Escape closes. */
	stuck?: string | null;
	/** The checkboxes' values as the dialog opens (Dorico remembers the last export's). */
	initial?: Record<string, 0 | 1>;
	/** The flows and layouts the project has. */
	flows?: string[];
	layouts?: string[];
};

const DEFAULTS: Record<string, 0 | 1> = {
	[MXL]: 0,
	[XML]: 1,
	[SEPARATE]: 1,
	[FOLDER]: 1,
};

export class FakeAx implements AxClient {
	/** Every command run, as its arguments. */
	readonly log: string[][] = [];
	exportOpen = false;
	openPanel = false;
	sheet = false;
	sheetValue = "";
	where = "Dorico Projects";
	exportTo = "/Users/administrator/Documents/Dorico Projects";
	readonly boxes: Record<string, 0 | 1>;
	/** The frontmost app's bundle ID: keys are refused unless it is Dorico's. */
	front = "com.apple.finder";
	/** Called on every command, before the fake acts on it. */
	onRun: ((args: string[]) => void) | null = null;
	private readonly o: Required<Omit<FakeAxOptions, "initial" | "stuck">> & { stuck: string | null };
	private readonly actions = new WeakMap<AxNode, () => void>();

	constructor(opts: FakeAxOptions = {}) {
		this.o = {
			trusted: true,
			title: "Hymn",
			dialogAppears: true,
			folderTakes: true,
			writesFile: true,
			alwaysSeparate: false,
			flows: ["Hymn"],
			layouts: ["Full score", "01_Voice"],
			...opts,
			stuck: opts.stuck ?? null,
		};
		this.boxes = { ...DEFAULTS };
		for (const f of this.o.flows) this.boxes[f] = 1;
		for (const l of this.o.layouts) this.boxes[l] = 1;
		Object.assign(this.boxes, opts.initial ?? {});
	}

	/** The `press` commands for checkboxes, by title. */
	get toggled(): string[] {
		return this.log
			.filter((a) => a[0] === "press" && a.includes("AXCheckBox"))
			.map((a) => a[a.indexOf("--title") + 1] as string);
	}

	async run(args: string[]): Promise<Record<string, unknown>> {
		this.log.push(args);
		this.onRun?.(args);
		const arg = (name: string) => {
			const i = args.indexOf(name);
			return i >= 0 ? args[i + 1] : undefined;
		};
		const command = args[0];
		if (command === "trusted") return { trusted: this.o.trusted };
		if (!this.o.trusted) return { trusted: false, error: "not trusted" };
		switch (command) {
			case "dump":
				return { trusted: true, app: "Dorico", windows: this.windows() };
			case "menu":
				if (arg("--path") !== "File/Export/MusicXML...")
					return { error: `no menu item ${arg("--path")}` };
				if (this.o.dialogAppears) this.exportOpen = true;
				return { menu: (arg("--path") ?? "").split("/"), ok: true };
			case "press":
				return this.press(arg("--title") ?? "", arg("--role"));
			case "set":
				if (!args.includes("--sheet") || !this.sheet) return { error: "no text field 0" };
				this.sheetValue = arg("--value") ?? "";
				return { set: 0, ok: true, fields: 1 };
			case "keys":
				return this.keys(arg("--combo") ?? "");
			case "dismiss":
				return this.dismiss();
			default:
				return { error: `unknown command ${command}` };
		}
	}

	private keys(combo: string): Record<string, unknown> {
		if (this.front !== DORICO)
			return { error: "the frontmost app isn't one MacBenchAX may type into" };
		if (combo === "cmd+shift+g" && this.openPanel) this.sheet = true;
		else if (combo === "return" && this.sheet) {
			this.sheet = false;
			if (this.o.folderTakes) this.where = basename(this.sheetValue.replace(/\/+$/, ""));
		} else if (combo === "escape") {
			if (this.sheet) this.sheet = false;
			else if (this.openPanel && this.o.stuck !== "Open") this.openPanel = false;
			else if (this.exportOpen && !this.openPanel && this.o.stuck !== "Export MusicXML")
				this.exportOpen = false;
		}
		return { keys: combo.split("+"), ok: true };
	}

	private dismiss(): Record<string, unknown> {
		const pressed: string[] = [];
		if (this.sheet) {
			this.sheet = false;
			pressed.push("Cancel");
		}
		if (this.openPanel) {
			pressed.push("Cancel");
			if (this.o.stuck !== "Open") this.openPanel = false;
		}
		if (this.exportOpen) {
			pressed.push("Cancel");
			if (this.o.stuck !== "Export MusicXML" && !this.openPanel) this.exportOpen = false;
		}
		return { trusted: true, pressed };
	}

	private press(title: string, role: string | undefined): Record<string, unknown> {
		const visit = (n: AxNode): AxNode | null => {
			if (n.AXTitle === title && (role === undefined || n.AXRole === role)) return n;
			for (const c of n.children ?? []) {
				const hit = visit(c);
				if (hit) return hit;
			}
			return null;
		};
		for (const w of this.windows()) {
			const el = visit(w);
			if (el) {
				this.actions.get(el)?.();
				return { pressed: title, ok: true };
			}
		}
		return { error: `nothing titled ${title}` };
	}

	private node(n: AxNode, act?: () => void): AxNode {
		if (act) this.actions.set(n, act);
		return n;
	}

	private box(title: string): AxNode {
		return this.node(
			{ AXRole: "AXCheckBox", AXTitle: title, AXValue: this.boxes[title] ?? 0 },
			() => {
				this.boxes[title] = this.boxes[title] ? 0 : 1;
			},
		);
	}

	private button(title: string, act: () => void, extra: Partial<AxNode> = {}): AxNode {
		return this.node({ AXRole: "AXButton", AXTitle: title, ...extra }, act);
	}

	windows(): AxNode[] {
		const ws: AxNode[] = [
			{
				AXRole: "AXWindow",
				AXSubrole: "AXStandardWindow",
				AXTitle: `${this.o.title} - Full score`,
			},
		];
		if (this.exportOpen) ws.push(this.exportDialog());
		if (this.openPanel) ws.push(this.openDialog());
		return ws;
	}

	private exportDialog(): AxNode {
		const modal = () => this.openPanel; // the Open panel is modal over the dialog
		const unless = (f: () => void) => () => {
			if (!modal()) f();
		};
		const cancel = unless(() => {
			if (this.o.stuck !== "Export MusicXML") this.exportOpen = false;
		});
		return {
			AXRole: "AXWindow",
			AXSubrole: "AXDialog",
			AXTitle: "Export MusicXML",
			children: [
				this.box(MXL),
				this.box(XML),
				{ AXRole: "AXStaticText", AXValue: "Select flows to export:" },
				...this.o.flows.map((f) => this.box(f)),
				this.button("Select All", () => {}),
				this.button("Select None", () => {}),
				this.box(SEPARATE),
				...this.o.layouts.map((l) => this.box(l)),
				this.button("Select All", () => {}),
				this.button("Select None", () => {}),
				{ AXRole: "AXStaticText", AXValue: "Export to:" },
				{
					AXRole: "AXStaticText",
					AXIdentifier: "ExportMusicXmlDialog.folderPathLabel",
					AXValue: this.exportTo,
				},
				this.button(
					GLYPH,
					unless(() => {
						this.openPanel = true;
					}),
					{ AXIdentifier: "ExportMusicXmlDialog.chooseFolderPathPushButton" },
				),
				this.box(FOLDER),
				{
					AXRole: "AXGroup",
					children: [
						this.button(
							"OK",
							unless(() => {
								this.exportOpen = false;
								this.write();
							}),
						),
						this.button("Cancel", cancel),
					],
				},
				{ AXRole: "AXButton", AXSubrole: "AXCloseButton" },
			],
		};
	}

	private openDialog(): AxNode {
		const children: AxNode[] = [
			{ AXRole: "AXPopUpButton", AXTitle: "Where:", AXValue: this.where },
			{ AXRole: "AXTextField", AXSubrole: "AXSearchField" },
			this.button("New Folder", () => {}),
			this.button("Cancel", () => {
				if (!this.sheet && this.o.stuck !== "Open") this.openPanel = false;
			}),
			this.button("Choose", () => {
				if (this.sheet) return;
				this.openPanel = false;
				if (this.o.folderTakes) this.exportTo = this.sheetValue.replace(/\/+$/, "");
			}),
		];
		if (this.sheet)
			children.push({
				AXRole: "AXSheet",
				children: [
					{ AXRole: "AXButton", AXTitle: "Close" },
					{ AXRole: "AXTextField", AXValue: this.sheetValue },
				],
			});
		return { AXRole: "AXWindow", AXSubrole: "AXDialog", AXTitle: "Open", children };
	}

	/** The files Dorico writes on OK, after a moment. */
	private write(): void {
		if (!this.o.writesFile) return;
		const dir = this.exportTo;
		const t = this.o.title;
		const exts = [this.boxes[XML] ? ".musicxml" : null, this.boxes[MXL] ? ".mxl" : null].filter(
			(e): e is string => e !== null,
		);
		const into = this.boxes[FOLDER] ? join(dir, `Flows from ${t}`) : dir;
		const separate = this.boxes[SEPARATE] || this.o.alwaysSeparate;
		const layouts = this.o.layouts.filter((l) => this.boxes[l]);
		const names = separate
			? layouts.map((l) => `${t} - ${l} - 01 ${t}`)
			: [`${t} - Full score - 01 ${t}`];
		setTimeout(() => {
			mkdirSync(into, { recursive: true });
			for (const n of names)
				for (const e of exts) writeFileSync(join(into, `${n}${e}`), `fake ${e} of ${n}\n`);
		}, 20);
	}
}
