/** Dorico Remote Control messages, as Dorico Elements 6.2.31 sends them (tests/recordings/). */

/** A status, full (`getstatus`, has `canUndo`) or pushed (only what changed). */
export type Status = {
	hasScore?: boolean;
	activeOpenScoreID?: number;
	activeViewContainerID?: number;
	[key: string]: unknown;
};

export type Layout = { layoutID: number; layoutName: string; layoutType: string };

/** A message from Dorico. */
export type Incoming = { message: string; [key: string]: unknown };

/** A step that failed, and why. `step` names it for the caller ("open", "export", …). */
export class DoricoError extends Error {
	constructor(
		message: string,
		readonly step = "dorico",
	) {
		super(message);
		this.name = "DoricoError";
	}
}
