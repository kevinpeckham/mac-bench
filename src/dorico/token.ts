/** The Remote Control session token Dorico issues on the first Allow, kept for silent reconnects. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadToken(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf8").trim() || null;
}

/** Saved readable by its owner only: the token lets anything on the Mac drive Dorico. */
export function saveToken(path: string, token: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, token, { mode: 0o600 });
	chmodSync(path, 0o600);
}
