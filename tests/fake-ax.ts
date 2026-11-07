/**
 * A fake MacBenchAX for tests: Dorico's windows as state, answering the
 * commands `ax/main.swift` takes the way the spike (2026-11-07) saw the real
 * ones answer, and acting as main.swift does: `--dialogs` scopes dump, press
 * and set to dialogs and other windows' sheets; `--depth` cuts the dump;
 * `press` takes the first match in walk order (`--after` skips up to a
 * marker); `dismiss` presses only buttons titled Cancel, a sheet's first,
 * so the Go to Folder sheet (which has only a Close button) stays up.
 *
 * The Export MusicXML dialog has the checkboxes Dorico 6.2 shows, in the
 * order its dump lists them; its folder button (titled with a private-use
 * glyph) opens a standard Open panel; Cmd-Shift-G there opens a sheet with
 * one text field, and Return in it moves the panel to the typed folder. OK
 * writes the export into the chosen folder the way Dorico does (a "Flows
 * from …" folder and one file per layout, unless told otherwise). Every
 * dialog is modal: while one is up, the menu and the windows behind it don't
 * respond. The main window holds decoy OK and Cancel buttons: pressing one
 * is recorded in `decoysPressed`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AxClient, isDialog } from "../src/ax/client.js";

export type AxNode = {
	AXRole: string;
	AXSubrole?: string;
	AXTitle?: string;
	AXValue?: string | number;
	AXIdentifier?: string;
	AXDescription?: string;
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
	/** The first menu press leaves the File menu dropped down and opens nothing. */
	menuSticksOnce?: boolean;
	/** Whether `set --sheet` takes the value. */
	setTakes?: boolean;
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
	/** A floating palette window (as Dorico's Mixer is) beside the document. */
	palette?: boolean;
};

const DEFAULTS: Record<string, 0 | 1> = {
	[MXL]: 0,
	[XML]: 1,
	[SEPARATE]: 1,
	[FOLDER]: 1,
};

type Options = Required<Omit<FakeAxOptions, "initial" | "stuck">> & { stuck: string | null };

export class FakeAx implements AxClient {
	/** Every command run, as its arguments. */
	readonly log: string[][] = [];
	exportOpen = false;
	openPanel = false;
	sheet = false;
	sheetValue = "";
	menuOpen: string | null = null;
	where = "Dorico Projects";
	exportTo = "/Users/administrator/Documents/Dorico Projects";
	readonly boxes: Record<string, 0 | 1>;
	/** The frontmost app's bundle ID: keys are refused unless it is Dorico's. */
	front = "com.apple.finder";
	/** When set, "Export to:" shows a path under this home as `~/…`. */
	tildeHome: string | null = null;
	/** Decoy buttons in the main window that were pressed (never should be). */
	readonly decoysPressed: string[] = [];
	/** Called on every command, before the fake acts on it. */
	onRun: ((args: string[]) => void) | null = null;
	private readonly o: Options;
	private menus = 0;
	private readonly actions = new WeakMap<AxNode, () => void>();

	constructor(opts: FakeAxOptions = {}) {
		this.o = {
			trusted: true,
			title: "Hymn",
			dialogAppears: true,
			menuSticksOnce: false,
			setTakes: true,
			folderTakes: true,
			writesFile: true,
			alwaysSeparate: false,
			flows: ["Hymn"],
			layouts: ["Full score", "01_Voice"],
			palette: false,
			...opts,
			stuck: opts.stuck ?? null,
		};
		this.boxes = {};
		this.resetBoxes(opts.initial ?? {});
	}

	/** Checkbox values, by section (flows and layouts may share a title). */
	private resetBoxes(initial: Record<string, 0 | 1>) {
		Object.assign(this.boxes, DEFAULTS);
		for (const f of this.o.flows) this.boxes[`flow:${f}`] = 1;
		for (const l of this.o.layouts) this.boxes[`layout:${l}`] = 1;
		for (const [k, v] of Object.entries(initial)) {
			if (k in DEFAULTS) this.boxes[k] = v;
			else if (this.o.layouts.includes(k)) this.boxes[`layout:${k}`] = v;
			else this.boxes[`flow:${k}`] = v;
		}
	}

	/** The `press` commands for checkboxes, by title. */
	get toggled(): string[] {
		return this.log
			.filter((a) => a[0] === "press" && a.includes("AXCheckBox"))
			.map((a) => a[a.indexOf("--title") + 1] as string);
	}

	/** Whether any dialog is up (they are all modal). */
	get modal(): boolean {
		return this.exportOpen || this.openPanel;
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
		const scoped = args.includes("--dialogs");
		switch (command) {
			case "dump": {
				const depth = Number(arg("--depth") ?? 8);
				const windows = this.scope(scoped).map((w) => cut(w, depth));
				return {
					trusted: true,
					app: "Dorico",
					windows,
					...(this.menuOpen ? { menuOpen: this.menuOpen } : {}),
				};
			}
			case "menu":
				return this.menu(arg("--path") ?? "");
			case "press":
				return this.press(arg("--title") ?? "", arg("--role"), arg("--after"), scoped);
			case "set": {
				if (!args.includes("--sheet")) return { error: "no text field 0" };
				const field = this.scope(scoped)
					.flatMap((w) => sheetFields(w))
					.at(0);
				if (!field) return { error: "no text field 0", fields: 0 };
				if (this.o.setTakes) this.sheetValue = arg("--value") ?? "";
				return { set: 0, ok: true, fields: 1 };
			}
			case "keys":
				return this.keys(arg("--combo") ?? "");
			case "dismiss":
				return this.dismiss();
			default:
				return { error: `unknown command ${command}` };
		}
	}

	private menu(path: string): Record<string, unknown> {
		if (path !== "File/Export/MusicXML...") return { error: `no menu item ${path}` };
		if (this.modal || this.menuOpen) return { menu: path.split("/"), ok: true }; // nothing responds
		this.menus++;
		if (this.o.menuSticksOnce && this.menus === 1) {
			this.menuOpen = "File";
			return { menu: path.split("/"), ok: true };
		}
		if (this.o.dialogAppears) this.exportOpen = true;
		return { menu: path.split("/"), ok: true };
	}

	private keys(combo: string): Record<string, unknown> {
		if (this.front !== DORICO)
			return { error: "the frontmost app isn't one MacBenchAX may type into" };
		if (combo === "cmd+shift+g" && this.openPanel && !this.sheet) this.sheet = true;
		else if (combo === "return" && this.sheet) {
			this.sheet = false;
			if (this.o.folderTakes) this.where = basename(this.sheetValue.replace(/\/+$/, ""));
		} else if (combo === "return" && this.openPanel) {
			this.choose(); // Return without the sheet: the panel's default button
		} else if (combo === "escape") {
			if (this.menuOpen) this.menuOpen = null;
			else if (this.sheet) this.sheet = false;
			else if (this.openPanel && this.o.stuck !== "Open") this.openPanel = false;
			else if (this.exportOpen && !this.openPanel && this.o.stuck !== "Export MusicXML")
				this.exportOpen = false;
		}
		return { keys: combo.split("+"), ok: true };
	}

	/** As main.swift: per window, a sheet's first Cancel, then (for a dialog) its own first Cancel. */
	private dismiss(): Record<string, unknown> {
		const pressed: string[] = [];
		for (const w of this.windows()) {
			for (const s of (w.children ?? []).filter((c) => c.AXRole === "AXSheet")) {
				const cancel = find(s, (n) => n.AXRole === "AXButton" && n.AXTitle === "Cancel");
				if (cancel) {
					this.actions.get(cancel)?.();
					pressed.push("Cancel");
				}
			}
			if (isDialog(w)) {
				const cancel = find(
					w,
					(n) => n.AXRole === "AXButton" && n.AXTitle === "Cancel",
					(n) => n.AXRole === "AXSheet",
				);
				if (cancel) {
					this.actions.get(cancel)?.();
					pressed.push("Cancel");
				}
			}
		}
		return { trusted: true, pressed };
	}

	private press(
		title: string,
		role: string | undefined,
		after: string | undefined,
		scoped: boolean,
	): Record<string, unknown> {
		let seen = after === undefined;
		for (const w of this.scope(scoped)) {
			const el = find(w, (n) => {
				if (!seen) {
					if (n.AXTitle === after || n.AXValue === after) seen = true;
					return false;
				}
				return n.AXTitle === title && (role === undefined || n.AXRole === role);
			});
			if (el) {
				this.actions.get(el)?.();
				return { pressed: title, ok: true };
			}
		}
		return { error: `nothing titled ${title}` };
	}

	/** The windows a command sees: with --dialogs, dialogs and other windows' sheets. */
	private scope(scoped: boolean): AxNode[] {
		const ws = this.windows();
		return scoped
			? ws.flatMap((w) =>
					isDialog(w) ? [w] : (w.children ?? []).filter((c) => c.AXRole === "AXSheet"),
				)
			: ws;
	}

	private node(n: AxNode, act?: () => void): AxNode {
		if (act) this.actions.set(n, act);
		return n;
	}

	private box(key: string, title: string, enabled: () => boolean): AxNode {
		return this.node(
			{ AXRole: "AXCheckBox", AXTitle: title, AXValue: this.boxes[key] ?? 0 },
			() => {
				if (enabled()) this.boxes[key] = this.boxes[key] ? 0 : 1;
			},
		);
	}

	private button(title: string, act: () => void, extra: Partial<AxNode> = {}): AxNode {
		return this.node({ AXRole: "AXButton", AXTitle: title, ...extra }, act);
	}

	/** Front to back, as AXWindows lists them. */
	windows(): AxNode[] {
		const ws: AxNode[] = [];
		if (this.openPanel) ws.push(this.openDialog());
		if (this.exportOpen) ws.push(this.exportDialog());
		if (this.o.palette)
			ws.push({
				AXRole: "AXWindow",
				AXSubrole: "AXFloatingWindow",
				AXTitle: "Mixer",
				children: [{ AXRole: "AXButton", AXSubrole: "AXCloseButton" }],
			});
		const decoy = (t: string) => this.button(t, () => this.decoysPressed.push(t));
		ws.push({
			AXRole: "AXWindow",
			AXSubrole: "AXStandardWindow",
			AXTitle: `${this.o.title} - Full score`,
			children: [
				{
					AXRole: "AXGroup",
					children: [
						{ AXRole: "AXGroup", children: [decoy("OK"), decoy("Cancel"), decoy(GLYPH)] },
						{ AXRole: "AXCheckBox", AXTitle: "Full score", AXValue: 1 },
						{ AXRole: "AXTextField", AXValue: "bar 1" },
					],
				},
			],
		});
		return ws;
	}

	private exportDialog(): AxNode {
		const free = () => !this.openPanel; // the Open panel is modal over the dialog
		const unless = (f: () => void) => () => {
			if (free()) f();
		};
		const cancel = unless(() => {
			if (this.o.stuck !== "Export MusicXML") this.exportOpen = false;
		});
		const label =
			this.tildeHome && this.exportTo.startsWith(`${this.tildeHome}/`)
				? `~${this.exportTo.slice(this.tildeHome.length)}`
				: this.exportTo;
		return {
			AXRole: "AXWindow",
			AXSubrole: "AXDialog",
			AXTitle: "Export MusicXML",
			children: [
				this.box(MXL, MXL, free),
				this.box(XML, XML, free),
				{ AXRole: "AXStaticText", AXValue: "Select flows to export:" },
				...this.o.flows.map((f) => this.box(`flow:${f}`, f, free)),
				this.button("Select All", () => {}),
				this.button("Select None", () => {}),
				this.box(SEPARATE, SEPARATE, free),
				...this.o.layouts.map((l) => this.box(`layout:${l}`, l, free)),
				this.button("Select All", () => {}),
				this.button("Select None", () => {}),
				{ AXRole: "AXStaticText", AXValue: "Export to:" },
				{
					AXRole: "AXStaticText",
					AXIdentifier: "ExportMusicXmlDialog.folderPathLabel",
					AXValue: label,
				},
				this.button(
					GLYPH,
					unless(() => {
						this.openPanel = true;
					}),
					{ AXIdentifier: "ExportMusicXmlDialog.chooseFolderPathPushButton" },
				),
				this.box(FOLDER, FOLDER, free),
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

	private choose() {
		this.openPanel = false;
		if (this.o.folderTakes && this.where === basename(this.sheetValue.replace(/\/+$/, "")))
			this.exportTo = this.sheetValue.replace(/\/+$/, "");
		else this.exportTo = `/Users/administrator/Documents/${this.where}`;
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
				if (!this.sheet) this.choose();
			}),
		];
		if (this.sheet)
			children.push({
				AXRole: "AXSheet",
				children: [
					// the Go to Folder sheet has no Cancel: dismiss can't close it, Escape can
					{ AXRole: "AXButton", AXDescription: "Close" },
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
		const layouts = this.o.layouts.filter((l) => this.boxes[`layout:${l}`]);
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

/** The first node under `n` (preorder) that `match` accepts, not looking inside `skip`. */
function find(
	n: AxNode,
	match: (n: AxNode) => boolean,
	skip: (n: AxNode) => boolean = () => false,
): AxNode | null {
	if (match(n)) return n;
	for (const c of n.children ?? []) {
		if (skip(c)) continue;
		const hit = find(c, match, skip);
		if (hit) return hit;
	}
	return null;
}

const sheetFields = (w: AxNode): AxNode[] => {
	const out: AxNode[] = [];
	const visit = (n: AxNode, inSheet: boolean) => {
		const s = inSheet || n.AXRole === "AXSheet";
		if (s && n.AXRole === "AXTextField") out.push(n);
		for (const c of n.children ?? []) visit(c, s);
	};
	visit(w, false);
	return out;
};

/** `n` with children only `depth` levels down (a copy). */
function cut(n: AxNode, depth: number): AxNode {
	const { children, ...rest } = n;
	return depth > 0 && children
		? { ...rest, children: children.map((c) => cut(c, depth - 1)) }
		: rest;
}
