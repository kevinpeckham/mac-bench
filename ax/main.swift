// MacBenchAX: the one program on the Mac granted Accessibility, so a job can
// read and answer an app's dialogs. It is generic on purpose: an ad-hoc
// signed app's grant is tied to its build (FINDINGS), so it changes rarely
// and the job logic lives in TypeScript (src/ax/client.ts,
// src/dorico/export.ts). Launched with
// `open -n -a MacBenchAX.app --args <command> … --out <file.json>`, so macOS
// makes it its own responsible process; every command writes JSON to --out,
// which is required, even for request, and must be inside
// ~/Library/Application Support/mac-bench/ (otherwise it exits 65 and
// writes nothing).
//
//   trusted                          {"trusted": Bool}
//   request                          ask macOS for the grant (its prompt)
//   dump [--depth N]                 the app's windows as a tree
//   press --title T [--role R]       press the first element titled T
//   set --value V (--field N | --sheet)  set a text field's value
//   menu --path "A/B/C"              press a menu-bar item by titles
//   keys --combo cmd+shift+g         post a key to the frontmost app (exit 5
//                                    unless that app is in ALLOWED)
//   dismiss                          press Cancel in every dialog and sheet
// dump, press, set, menu and dismiss take --app <bundle ID> (default and
// only allowed: com.steinberg.dorico6).
// It acts only on the apps in ALLOWED, matched by bundle ID (a running
// app's name can be anything), posts keys only while one of them is
// frontmost, and writes its answer only inside the mac-bench work folder,
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
let ALLOWED = ["com.steinberg.dorico6"]
let WORK = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/mac-bench")
let out: String = {
	let given = (arg("--out").map { ($0 as NSString).standardizingPath }) ?? ""
	guard given.hasPrefix(WORK + "/"), !given.contains("/../") else { exit(65) } // nowhere to answer
	return given
}()

func finish(_ obj: [String: Any], code: Int32 = 0) -> Never {
	let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
	// Write beside, then rename: the reader polls for the file and must never see half of it.
	let tmp = out + ".part"
	FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600])
	_ = try? FileManager.default.removeItem(atPath: out)
	try? FileManager.default.moveItem(atPath: tmp, toPath: out)
	exit(code)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
	var v: AnyObject?
	return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func kids(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

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

/// Every element under the app's windows, depth-first, with whether it is inside a sheet.
func walk(_ root: AXUIElement, depth: Int = 14, inSheet: Bool = false, _ visit: (AXUIElement, Bool) -> Bool) -> Bool {
	let sheet = inSheet || str(root, kAXRoleAttribute) == kAXSheetRole
	if visit(root, sheet) { return true }
	guard depth > 0 else { return false }
	for k in kids(root) where walk(k, depth: depth - 1, inSheet: sheet, visit) { return true }
	return false
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

switch command {
case "dump":
	let depth = Int(arg("--depth") ?? "8") ?? 8
	finish(["trusted": true, "app": appName, "windows": windows.map { describe($0, depth: depth) }])
case "press":
	let title = arg("--title") ?? ""
	let role = arg("--role")
	var found: AXUIElement?
	for w in windows where found == nil {
		_ = walk(w) { el, _ in
			guard str(el, kAXTitleAttribute) == title, role == nil || str(el, kAXRoleAttribute) == role else { return false }
			found = el
			return true
		}
	}
	guard let el = found else { finish(["error": "nothing titled \(title)"], code: 4) }
	let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
	finish(["pressed": title, "ok": r == .success])
case "set":
	let n = Int(arg("--field") ?? "0") ?? 0
	let wantSheet = args.contains("--sheet")
	var fields: [AXUIElement] = []
	for w in windows {
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
	guard var node = attr(app, kAXMenuBarAttribute) as! AXUIElement? else { finish(["error": "no menu bar"], code: 4) }
	let steps = (arg("--path") ?? "").split(separator: "/").map(String.init)
	for (i, title) in steps.enumerated() {
		var items = kids(node)
		// a menu item's children are one AXMenu: step into it
		if items.count == 1, str(items[0], kAXRoleAttribute) == kAXMenuRole { items = kids(items[0]) }
		guard let next = items.first(where: { str($0, kAXTitleAttribute) == title }) else {
			finish(["error": "no menu item \(title)", "at": i, "items": items.compactMap { str($0, kAXTitleAttribute) }], code: 4)
		}
		node = next
		if i < steps.count - 1 { AXUIElementPerformAction(node, kAXPressAction as CFString); usleep(150_000) }
	}
	let r = AXUIElementPerformAction(node, kAXPressAction as CFString)
	finish(["menu": steps, "ok": r == .success])
case "dismiss":
	var pressed: [String] = []
	for w in windows {
		let sub = str(w, kAXSubroleAttribute)
		let dialog = sub == kAXDialogSubrole || sub == kAXSystemDialogSubrole
		// a sheet's Cancel first, then the dialog's own
		for s in kids(w) where str(s, kAXRoleAttribute) == kAXSheetRole {
			_ = walk(s) { el, _ in
				guard str(el, kAXRoleAttribute) == kAXButtonRole, str(el, kAXTitleAttribute) == "Cancel" else { return false }
				if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { pressed.append("Cancel") }
				return true
			}
		}
		if dialog {
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
