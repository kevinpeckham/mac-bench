// MacBenchAX: the one program on the Mac granted Accessibility, so a job can
// read and answer an app's dialogs. It is generic on purpose: an ad-hoc
// signed app's grant is tied to its build (FINDINGS), so it changes rarely
// and the job logic lives in TypeScript (src/ax/client.ts,
// src/dorico/export.ts). Launched with
// `open -n -a MacBenchAX.app --args <command> … --out <file.json>`, so macOS
// makes it its own responsible process; every command writes JSON to --out.
// --out is required, even for request, and must be a .json file directly in
// ~/Library/Application Support/mac-bench/ax/answers/, which must exist;
// otherwise it says why on stderr, exits 65 (bad --out) or 66 (no folder)
// and writes nothing.
//
//   trusted                          {"trusted": Bool}
//   request                          ask macOS for the grant (its prompt)
//   dump [--depth N] [--dialogs]     the app's windows as a tree, and
//                                    menuOpen: the title of an open menu
//   press --title T [--role R] [--after A] [--dialogs]
//                                    press the first element titled T (after
//                                    the first element titled or valued A)
//   set --value V (--field N | --sheet) [--dialogs]  set a text field's value
//   menu --path "A/B/C"              press a menu-bar item by titles; a
//                                    missing step closes the menus it opened
//   keys --combo cmd+shift+g         post a key to the frontmost app (exit 5
//                                    unless that app is in ALLOWED)
//   dismiss                          press Cancel in every dialog and sheet
// --dialogs: look only at dialogs (AXDialog, AXSystemDialog) and the sheets
// of other windows, never into a document window's (large) tree.
// dump, press, set, menu and dismiss take --app <bundle ID> (default and
// only allowed: com.steinberg.dorico6).
// It acts only on the apps in ALLOWED, matched by bundle ID (a running
// app's name can be anything), posts keys only while one of them is
// frontmost, and writes its answer only inside the mac-bench answers folder,
// owner-only. Any program running as this user can still launch it: the Mac
// is single-user, and the grant is kept that narrow on purpose.
import AppKit
import ApplicationServices
import Foundation

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
	guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
	return args[i + 1]
}
func fail(_ message: String, _ code: Int32) -> Never {
	FileHandle.standardError.write(("MacBenchAX: " + message + "\n").data(using: .utf8) ?? Data())
	exit(code)
}
let ALLOWED = ["com.steinberg.dorico6"]
let WORK = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/mac-bench")
let ANSWERS = (WORK as NSString).appendingPathComponent("ax/answers")
let out: String = {
	guard let raw = arg("--out") else { fail("--out <file.json> is required", 65) }
	let given = (raw as NSString).standardizingPath
	guard (given as NSString).deletingLastPathComponent == ANSWERS, given.hasSuffix(".json") else {
		fail("--out must be a .json file directly in \(ANSWERS)", 65)
	}
	// The folder itself, not a symlink to somewhere else (attributesOfItem doesn't follow links).
	let kind = (try? FileManager.default.attributesOfItem(atPath: ANSWERS))?[.type] as? FileAttributeType
	guard kind == .typeDirectory else { fail("\(ANSWERS) is missing (or not a folder)", 66) }
	return given
}()

func finish(_ obj: [String: Any], code: Int32 = 0) -> Never {
	let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
	// Write beside, then rename: the reader polls for the file and must never see half of it.
	// The .part is created exclusively (never through a link or over another file); rename
	// replaces a file but never a folder.
	let tmp = out + ".part"
	let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
	guard fd >= 0 else { fail("can't create \(tmp)", 73) }
	let written = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
	close(fd)
	guard written == data.count, rename(tmp, out) == 0 else {
		unlink(tmp)
		fail("can't write \(out)", 73)
	}
	exit(code)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
	var v: AnyObject?
	return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func kids(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func element(_ v: AnyObject?) -> AXUIElement? {
	guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
	return (v as! AXUIElement)
}

func describe(_ el: AXUIElement, depth: Int) -> [String: Any] {
	var d: [String: Any] = [:]
	for k in [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute] {
		if let v = str(el, k), !v.isEmpty { d[k] = v }
	}
	switch attr(el, kAXValueAttribute) {
	case let v as String where !v.isEmpty: d["AXValue"] = String(v.prefix(200))
	case let v as NSNumber: d["AXValue"] = v // a checkbox's 0 or 1
	default: break
	}
	if depth > 0 {
		let k = kids(el)
		if !k.isEmpty { d["children"] = k.prefix(200).map { describe($0, depth: depth - 1) } }
	}
	return d
}

/// Every element under `root`, depth-first, with whether it is inside a sheet.
func walk(_ root: AXUIElement, depth: Int = 14, inSheet: Bool = false, _ visit: (AXUIElement, Bool) -> Bool) -> Bool {
	let sheet = inSheet || str(root, kAXRoleAttribute) == kAXSheetRole
	if visit(root, sheet) { return true }
	guard depth > 0 else { return false }
	for k in kids(root) where walk(k, depth: depth - 1, inSheet: sheet, visit) { return true }
	return false
}

func isDialog(_ w: AXUIElement) -> Bool {
	let sub = str(w, kAXSubroleAttribute)
	return sub == kAXDialogSubrole || sub == kAXSystemDialogSubrole
}

let command = args.count > 1 ? args[1] : "trusted"
let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
if command == "request" {
	let asked = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
	sleep(2) // let the prompt appear before this process goes
	finish(["trusted": asked, "requested": true])
}
let trusted = AXIsProcessTrustedWithOptions([prompt: false] as CFDictionary)
if command == "trusted" { finish(["trusted": trusted]) }
guard trusted else { finish(["trusted": false, "error": "not trusted"], code: 2) }

/// The allowed app, running, matched by bundle ID.
func target() -> NSRunningApplication? {
	let id = arg("--app") ?? ALLOWED[0]
	guard ALLOWED.contains(id) else { return nil }
	return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == id }
}

if command == "keys" {
	guard let front = NSWorkspace.shared.frontmostApplication, let id = front.bundleIdentifier, ALLOWED.contains(id) else {
		finish(["error": "the frontmost app isn't one MacBenchAX may type into"], code: 5)
	}
	let parts = (arg("--combo") ?? "").lowercased().split(separator: "+").map(String.init)
	// Virtual key codes: positions on an ANSI (US) keyboard. Escape, Return,
	// Tab and Space are the same everywhere; the letters are where US has
	// them, so on another layout "g" may be a different letter.
	let codes: [String: CGKeyCode] = ["escape": 53, "return": 36, "tab": 48, "space": 49, "g": 5, "a": 0, "s": 1]
	guard let key = parts.last, let code = codes[key] else { finish(["error": "unknown key"], code: 4) }
	var flags: CGEventFlags = []
	if parts.contains("cmd") { flags.insert(.maskCommand) }
	if parts.contains("shift") { flags.insert(.maskShift) }
	if parts.contains("alt") { flags.insert(.maskAlternate) }
	for down in [true, false] {
		let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
		e?.flags = flags
		e?.post(tap: .cghidEventTap)
	}
	finish(["keys": parts, "ok": true])
}

guard let running = target() else {
	finish(["error": "\(arg("--app") ?? ALLOWED[0]) isn't allowed or isn't running"], code: 3)
}
let appName = running.localizedName ?? ""
let app = AXUIElementCreateApplication(running.processIdentifier)
let windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
/// The windows a command looks into: with --dialogs, the dialogs and the sheets of other windows.
let scope: [AXUIElement] = args.contains("--dialogs")
	? windows.flatMap { w in isDialog(w) ? [w] : kids(w).filter { str($0, kAXRoleAttribute) == kAXSheetRole } }
	: windows
let menuBar = element(attr(app, kAXMenuBarAttribute))
/// The title of a menu-bar item whose menu is open, if any.
func openMenu() -> String? {
	guard let bar = menuBar else { return nil }
	for item in kids(bar) where (attr(item, kAXSelectedAttribute) as? Bool) == true { return str(item, kAXTitleAttribute) ?? "" }
	return nil
}

switch command {
case "dump":
	let depth = Int(arg("--depth") ?? "8") ?? 8
	var answer: [String: Any] = ["trusted": true, "app": appName, "windows": scope.map { describe($0, depth: depth) }]
	if let m = openMenu() { answer["menuOpen"] = m }
	finish(answer)
case "press":
	let title = arg("--title") ?? ""
	let role = arg("--role")
	let after = arg("--after")
	var seen = after == nil
	var found: AXUIElement?
	for w in scope where found == nil {
		_ = walk(w) { el, _ in
			if !seen {
				if let a = after, str(el, kAXTitleAttribute) == a || str(el, kAXValueAttribute) == a { seen = true }
				return false
			}
			guard str(el, kAXTitleAttribute) == title, role == nil || str(el, kAXRoleAttribute) == role else { return false }
			found = el
			return true
		}
	}
	guard let el = found else { finish(["error": "nothing titled \(title)" + (after.map { " after \($0)" } ?? "")], code: 4) }
	let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
	finish(["pressed": title, "ok": r == .success])
case "set":
	let n = Int(arg("--field") ?? "0") ?? 0
	let wantSheet = args.contains("--sheet")
	var fields: [AXUIElement] = []
	for w in scope {
		_ = walk(w) { el, inSheet in
			if str(el, kAXRoleAttribute) == kAXTextFieldRole, !wantSheet || inSheet { fields.append(el) }
			return false
		}
	}
	let i = wantSheet ? 0 : n
	guard i < fields.count else { finish(["error": "no text field \(i)", "fields": fields.count], code: 4) }
	let r = AXUIElementSetAttributeValue(fields[i], kAXValueAttribute as CFString, (arg("--value") ?? "") as CFString)
	finish(["set": i, "ok": r == .success, "fields": fields.count])
case "menu":
	guard let bar = menuBar else { finish(["error": "no menu bar"], code: 4) }
	var node = bar
	var opened: [AXUIElement] = []
	let steps = (arg("--path") ?? "").split(separator: "/").map(String.init)
	for (i, title) in steps.enumerated() {
		var items = kids(node)
		// a menu item's children are one AXMenu: step into it
		if items.count == 1, str(items[0], kAXRoleAttribute) == kAXMenuRole { items = kids(items[0]) }
		guard let next = items.first(where: { str($0, kAXTitleAttribute) == title }) else {
			// Close what this opened, deepest first; a top item still open is pressed shut.
			for el in opened.reversed() { _ = AXUIElementPerformAction(el, kAXCancelAction as CFString) }
			if let top = opened.first, (attr(top, kAXSelectedAttribute) as? Bool) == true {
				_ = AXUIElementPerformAction(top, kAXPressAction as CFString)
			}
			finish(["error": "no menu item \(title)", "at": i, "items": items.compactMap { str($0, kAXTitleAttribute) }], code: 4)
		}
		node = next
		if i < steps.count - 1 {
			_ = AXUIElementPerformAction(node, kAXPressAction as CFString)
			opened.append(node)
			usleep(150_000)
		}
	}
	let r = AXUIElementPerformAction(node, kAXPressAction as CFString)
	finish(["menu": steps, "ok": r == .success])
case "dismiss":
	var pressed: [String] = []
	for w in windows {
		// a sheet's Cancel first, then the dialog's own
		for s in kids(w) where str(s, kAXRoleAttribute) == kAXSheetRole {
			_ = walk(s) { el, _ in
				guard str(el, kAXRoleAttribute) == kAXButtonRole, str(el, kAXTitleAttribute) == "Cancel" else { return false }
				if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { pressed.append("Cancel") }
				return true
			}
		}
		if isDialog(w) {
			_ = walk(w, depth: 10) { el, inSheet in
				guard !inSheet, str(el, kAXRoleAttribute) == kAXButtonRole, str(el, kAXTitleAttribute) == "Cancel" else { return false }
				if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { pressed.append("Cancel") }
				return true
			}
		}
	}
	finish(["trusted": true, "pressed": pressed])
default:
	finish(["error": "unknown command \(command)"], code: 64)
}
