/**
 * Dorico's MIDI Import Options window (Elements 6.2.31, 2026-11-08):
 * `File.Open` of a `.mid` answers `kOK`, makes no project and shows it; the
 * project is made only once it is accepted. It can't be found, read or
 * pressed through Accessibility: Dorico's standard windows (project windows
 * and this one) describe themselves as the application (AXRole
 * "AXApplication", AXTitle "Dorico", no subrole), with the app's own
 * windows and menu bar again as their children, a self-similar tree with no
 * title and no contents (FINDINGS). Dialogs and sheets are described
 * properly. So the MIDI job only counts Dorico's windows (`windowCount`),
 * and accepts the window with Return (`midi.ts`).
 */
import { type AxClient, type AxNode, isDialog } from "../ax/client.js";

/** The window's title, as Dorico shows it on screen: for messages only. */
export const IMPORT_WINDOW = "MIDI Import Options";

/** Run a MacBenchAX command; an `error` in its answer, or `ok: false`, throws. */
export async function axCommand(
	client: AxClient,
	...args: string[]
): Promise<Record<string, unknown>> {
	const r = await client.run(args);
	if (typeof r.error === "string") throw new Error(`MacBenchAX ${args[0]}: ${r.error}`);
	if (r.ok === false) throw new Error(`MacBenchAX ${args.join(" ")} didn't take`);
	return r;
}

/**
 * All of Dorico's windows, documents included, `depth` levels down. Keep
 * `depth` small: each standard window lists every window again under it,
 * so a dump grows as the number of windows to the power of its depth.
 */
const allWindows = async (client: AxClient, depth: number) => {
	const r = await axCommand(client, "dump", "--depth", String(depth));
	return Array.isArray(r.windows) ? (r.windows as AxNode[]) : [];
};

/** A window that isn't a dialog or a sheet: a project window, the import window, a palette. */
const isStandard = (w: AxNode) => !isDialog(w) && w.AXRole !== "AXSheet";

/**
 * How many windows Dorico shows that are neither dialogs nor sheets (a dump
 * with no depth: nothing inside them is read). The import window is one of
 * them, though it says only that it is the application.
 */
export const windowCount = async (client: AxClient) =>
	(await allWindows(client, 0)).filter(isStandard).length;

const label = (n: AxNode) =>
	n.AXRole === "AXApplication"
		? "window (opaque to Accessibility)"
		: `${n.AXRole ?? "?"}${n.AXSubrole ? `/${n.AXSubrole}` : ""}${n.AXTitle ? ` "${n.AXTitle}"` : ""}`;

/**
 * Dorico's windows, their roles and titles and a dialog's children's, for
 * an error message: one level down, an opaque window by its label alone.
 */
export async function windowSummary(client: AxClient): Promise<string> {
	try {
		const ws = await allWindows(client, 1);
		if (ws.length === 0) return "no windows";
		return ws
			.map((w) => {
				const kids = w.AXRole === "AXApplication" ? [] : (w.children ?? []);
				const shown = kids.slice(0, 8).map(label);
				if (kids.length > shown.length) shown.push(`… ${kids.length - shown.length} more`);
				return shown.length ? `${label(w)} [${shown.join(", ")}]` : label(w);
			})
			.join("; ");
	} catch (e) {
		return `couldn't list Dorico's windows (${(e as Error).message})`;
	}
}

/** `n` and everything under it, in the order the dump lists them. */
export const flat = (n: AxNode, acc: AxNode[] = []): AxNode[] => {
	acc.push(n);
	for (const c of n.children ?? []) flat(c, acc);
	return acc;
};
