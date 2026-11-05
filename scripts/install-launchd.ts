#!/usr/bin/env bun
/**
 * Install the helper as a launchd user agent on this Mac, so it starts at
 * login and restarts if it stops:  bun scripts/install-launchd.ts
 * Logs: ~/Library/Logs/mac-bench.log. Remove: launchctl bootout gui/$UID/dev.lj.mac-bench
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LABEL = "dev.lj.mac-bench";
const home = homedir();
const plist = join(home, "Library/LaunchAgents", `${LABEL}.plist`);
const log = join(home, "Library/Logs/mac-bench.log");
const repo = resolve(import.meta.dir, "..");
const bun = process.execPath;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

mkdirSync(dirname(plist), { recursive: true });
writeFileSync(
	plist,
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array><string>${esc(bun)}</string><string>run</string><string>helper</string></array>
	<key>WorkingDirectory</key><string>${esc(repo)}</string>
	<key>EnvironmentVariables</key>
	<dict><key>PATH</key><string>${esc(dirname(bun))}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${esc(log)}</string>
	<key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`,
);
const uid = process.getuid?.() ?? 501;
Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${LABEL}`]); // fine if not loaded
const boot = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, plist]);
if (boot.exitCode !== 0) {
	console.error(`launchctl bootstrap failed: ${boot.stderr.toString()}`);
	process.exit(1);
}
console.log(`Installed ${plist}\nLogs: ${log}`);
