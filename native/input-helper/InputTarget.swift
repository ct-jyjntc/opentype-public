import AppKit
import ApplicationServices

private func targetAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func targetElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
// AXURL providers may return either a CFString or a CFURL/NSURL. Preserve the
// actual URL so the existing domain privacy filter can make its decision.
func inputTargetURL(_ value: CFTypeRef?) -> String? {
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
}
private func targetRange(_ element: AXUIElement) -> CFRange? {
    guard let value = targetAttr(element, kAXSelectedTextRangeAttribute as String), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}
private func targetJSON(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let string = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(string)
}
private func editableTarget(_ element: AXUIElement, failure: ((String) -> Void)? = nil) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<12 {
        guard let node = current else { return nil }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        let subrole = targetAttr(node, kAXSubroleAttribute as String) as? String ?? ""
        if (role + subrole).lowercased().contains("secure") { return nil }
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
            if targetAttr(node, kAXEnabledAttribute as String) as? Bool == false { failure?("injection_target_disabled"); return nil }
            if targetAttr(node, "AXEditable") as? Bool == false { failure?("injection_target_readonly"); return nil }
            // Chromium readonly fields omit AXEditable entirely. Check value
            // editability before reading their contents or recording a token.
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { failure?("injection_target_value_not_settable"); return nil }
            return node
        }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return nil
}
private func focusedTarget() -> AXUIElement? {
    guard let element = targetElement(targetAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as String)) else { return nil }
    return editableTarget(element)
}

/// AX ranges use UTF-16, not Swift grapheme counts. Refuse out-of-bounds and
/// surrogate-splitting ranges; never expand a selection to neighbouring text.
func expectedInsertion(_ original: String, _ range: CFRange, _ text: String) -> String? {
    let value = original as NSString
    guard range.location >= 0, range.length >= 0, range.location <= value.length,
          range.length <= value.length - range.location else { return nil }
    for at in [range.location, range.location + range.length] where at > 0 && at < value.length {
        if (0xD800...0xDBFF).contains(value.character(at: at - 1)) && (0xDC00...0xDFFF).contains(value.character(at: at)) { return nil }
    }
    return value.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
}

private final class InputTarget {
    let app: NSRunningApplication
    let element: AXUIElement
    let window: AXUIElement?
    let value: String?
    let range: CFRange?
    var expected: String?
    var insertedText: String?
    var submitted = false
    var verified = false
    var observingSince: TimeInterval?
    let webUrls: [String]
    let webRedacted: Bool
    init(app: NSRunningApplication, element: AXUIElement) {
        self.app = app; self.element = element
        window = targetElement(targetAttr(element, kAXWindowAttribute as String))
        let original = targetAttr(element, kAXValueAttribute as String) as? String
        value = original
        range = targetRange(element)
        let web = targetWebContext(element)
        webUrls = web.urls; webRedacted = web.redacted
    }
    func valid() -> String? {
        if !AXIsProcessTrusted() { return "injection_permission" }
        if app.isTerminated { return "injection_target_closed" }
        guard !secureTarget(element), editableTarget(element) != nil else { return "injection_target_unavailable" }
        if let value, targetAttr(element, kAXValueAttribute as String) as? String != value { return "injection_target_changed" }
        return nil
    }
    func ready() -> String? {
        if let error = valid() { return error }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let focused = focusedTarget(), CFEqual(focused, element) else { return "injection_focus_pending" }
        if let range {
            guard let current = targetRange(element), current.location == range.location, current.length == range.length else { return "injection_selection_changed" }
        }
        return nil
    }
}
// Opaque handles never leave the main process and never enter history or network requests.
private var inputTargets: [String: InputTarget] = [:]

private func secureTarget(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<64 {
        guard let node = current else { return false }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        let subrole = targetAttr(node, kAXSubroleAttribute as String) as? String ?? ""
        if (role + subrole).lowercased().contains("secure") || targetAttr(node, "AXProtectedContent") as? Bool == true { return true }
        if role == "AXWebArea" || role == "AXWindow" { return false }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return true
}
private func selectedTargetText(_ element: AXUIElement) -> String? {
    if let text = targetAttr(element, kAXSelectedTextAttribute as String) as? String, !text.isEmpty { return text }
    guard let markers = targetAttr(element, "AXSelectedTextMarkerRange") else { return nil }
    var text: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element, "AXStringForTextMarkerRange" as CFString, markers, &text) == .success else { return nil }
    return text as? String
}
// Include ancestor document URLs (such as an iframe's parent), so a domain
// restriction on the containing page cannot be bypassed by an embedded editor.
private func targetWebContext(_ element: AXUIElement) -> (urls: [String], redacted: Bool) {
    var current: AXUIElement? = element, urls: [String] = [], web = false
    for _ in 0..<64 {
        guard let node = current else { return (urls, web && urls.isEmpty) }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        if role == "AXWebArea" {
            web = true
            if let value = inputTargetURL(targetAttr(node, kAXURLAttribute as String)),
               let url = URL(string: value), ["http", "https", "file"].contains(url.scheme?.lowercased() ?? ""),
               !urls.contains(value) { urls.append(value) }
        }
        if role == "AXApplication" { return (urls, web && urls.isEmpty) }
        current = targetElement(targetAttr(node, kAXParentAttribute as String))
    }
    return (urls, true)
}
private func targetDiagnostics(_ element: AXUIElement? = nil, app: NSRunningApplication? = nil) -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    var data: [String: Any] = ["trusted": AXIsProcessTrusted(), "frontPid": Int(front?.processIdentifier ?? 0), "frontBundleId": front?.bundleIdentifier ?? "", "targetPid": Int(app?.processIdentifier ?? 0), "targetBundleId": app?.bundleIdentifier ?? ""]
    var focused: CFTypeRef?
    let focusError = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focused)
    data["focusError"] = focusError.rawValue
    data["focusReadable"] = targetElement(focused) != nil
    if let app { data["frontMatches"] = front?.processIdentifier == app.processIdentifier }
    guard let node = element ?? targetElement(focused) else { return data }
    data["role"] = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
    var pid: pid_t = 0
    data["pidError"] = AXUIElementGetPid(node, &pid).rawValue
    if app == nil { data["targetPid"] = Int(pid) }
    if let focus = targetElement(focused) { data["focusMatches"] = CFEqual(focus, node) }
    var writable = DarwinBoolean(false)
    let valueError = AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &writable)
    data["valueSettable"] = valueError == .success && writable.boolValue
    writable = DarwinBoolean(false)
    let rangeError = AXUIElementIsAttributeSettable(node, kAXSelectedTextRangeAttribute as CFString, &writable)
    data["rangeSettable"] = rangeError == .success && writable.boolValue
    // Only capability booleans survive; never return values or selected text.
    data["valueReadable"] = targetAttr(node, kAXValueAttribute as String) is String
    data["rangeReadable"] = targetRange(node) != nil
    return data
}

@_cdecl("inputTargetDiagnostics")
public func inputTargetDiagnostics(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    if let tokenPtr, let target = inputTargets[String(cString: tokenPtr)] { return targetJSON(targetDiagnostics(target.element, app: target.app)) }
    return targetJSON(targetDiagnostics())
}

private func captureTarget(_ allowReadOnlySelection: Bool) -> UnsafeMutablePointer<CChar>? {
    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = ["diagnostics": targetDiagnostics(app: app), "appName": app?.localizedName ?? "", "bundleId": app?.bundleIdentifier ?? "", "pid": Int(app?.processIdentifier ?? 0)]
    guard AXIsProcessTrusted() else { result["reason"] = "injection_permission"; return targetJSON(result) }
    guard let app else { result["reason"] = "injection_front_app_missing"; return targetJSON(result) }
    var focusValue: CFTypeRef?
    let focusError = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focusValue)
    guard focusError == .success, let focused = targetElement(focusValue) else {
        result["reason"] = "injection_focus_unavailable"; return targetJSON(result)
    }
    result["diagnostics"] = targetDiagnostics(focused, app: app)
    var pid: pid_t = 0
    guard AXUIElementGetPid(focused, &pid) == .success else { result["reason"] = "injection_focus_pid_unavailable"; result["contextRedacted"] = true; return targetJSON(result) }
    guard pid == app.processIdentifier else { result["reason"] = "injection_focus_pid_mismatch"; result["contextRedacted"] = true; return targetJSON(result) }
    guard !secureTarget(focused) else { result["reason"] = "injection_secure_target"; result["contextRedacted"] = true; return targetJSON(result) }
    var captureFailure = "injection_target_not_editable"
    let editable = editableTarget(focused, failure: { captureFailure = $0 }), element = editable ?? focused
    if let window = targetElement(targetAttr(element, kAXWindowAttribute as String)),
       let rawPosition = targetAttr(window, kAXPositionAttribute as String),
       let rawSize = targetAttr(window, kAXSizeAttribute as String),
       CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() {
        var position = CGPoint.zero, size = CGSize.zero
        if AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
           AXValueGetValue(rawSize as! AXValue, .cgSize, &size) {
            result["windowBounds"] = ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
        }
    }
    let web = targetWebContext(element)
    result["webUrls"] = web.urls; result["webUrl"] = web.urls.first
    result["contextRedacted"] = web.redacted
    result["role"] = targetAttr(element, kAXRoleAttribute as String) as? String ?? ""
    if let editable, inputTargets.count < 16 {
        let snapshot = InputTarget(app: app, element: editable)
        captureFailure = snapshot.value == nil ? "injection_target_value_unavailable" : snapshot.range == nil ? "injection_target_range_unavailable" : "injection_selection_changed"
        if let value = snapshot.value, let range = snapshot.range, expectedInsertion(value, range, "") != nil {
            let token = UUID().uuidString
            inputTargets[token] = snapshot; result["token"] = token
            if !web.redacted {
                let source = value as NSString
                result["selectedText"] = source.substring(with: NSRange(location: range.location, length: range.length))
                let start = max(0, range.location - 800), end = min(source.length, range.location + range.length + 400)
                result["contextText"] = source.substring(with: NSRange(location: start, length: min(2000, end - start)))
            }
            return targetJSON(result)
        }
    }
    // Explicit question mode may read the user's selected text without making
    // the source an insertion target. Never copy the entire readonly document.
    result["reason"] = inputTargets.count >= 16 ? "injection_target_capacity" : captureFailure
    if allowReadOnlySelection && !web.redacted, let text = selectedTargetText(element), !text.isEmpty {
        result["selectedText"] = text; result["selectionReadOnly"] = true
    }
    return targetJSON(result)
}
@_cdecl("captureInputTarget")
public func captureInputTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(false) }
@_cdecl("captureCommandTarget")
public func captureCommandTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(true) }

private func prepareInputTargetOnMain(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], !target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    if let reason = target.valid() { return targetJSON(["reason": reason]) }
    // Activate only this existing process. A closed target is never relaunched.
    let activated = target.app.activate(options: [.activateIgnoringOtherApps])
    guard activated else { return targetJSON(["reason": "injection_activation_failed", "activateOk": false]) }
    var result: [String: Any] = ["ok": true, "activateOk": true]
    if let window = target.window { result["raiseError"] = AXUIElementPerformAction(window, kAXRaiseAction as CFString).rawValue }
    result["setFocusError"] = AXUIElementSetAttributeValue(target.element, kAXFocusedAttribute as CFString, kCFBooleanTrue).rawValue
    if var range = target.range, let axRange = AXValueCreate(.cfRange, &range) {
        result["setRangeError"] = AXUIElementSetAttributeValue(target.element, kAXSelectedTextRangeAttribute as CFString, axRange).rawValue
    }
    return targetJSON(result)
}

@_cdecl("inputTargetReady")
public func inputTargetReady(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)] else { return targetJSON(["reason": "injection_target_unavailable"]) }
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    return targetJSON(["ok": true])
}

private func commitInputTargetOnMain(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let textPtr, let target = inputTargets[String(cString: tokenPtr)] else { return targetJSON(["reason": "injection_target_unavailable"]) }
    if target.submitted { return targetJSON(["reason": "injection_already_sent"]) }
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    let text = String(cString: textPtr)
    guard !text.isEmpty else { return targetJSON(["reason": "injection_failed"]) }
    if let value = target.value, let range = target.range {
        guard let expected = expectedInsertion(value, range, text) else { return targetJSON(["reason": "injection_selection_changed"]) }
        target.expected = expected
        target.insertedText = text
    }
    // Chromium advertises AXSelectedText as settable but may ignore the write.
    // Send one normal paste to the captured process, preserving editor undo and
    // input handlers, then verify the resulting value. Never retry a write.
    target.submitted = true
    guard pasteViaClipboard(text, pid: target.app.processIdentifier) else { return targetJSON(["reason": "injection_failed"]) }
    return targetJSON(["submitted": true, "method": "clipboard"])
}

@_cdecl("verifyInputTarget")
public func verifyInputTarget(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    guard let expected = target.expected else { return targetJSON(["status": "unverified"]) }
    guard !target.app.isTerminated, !secureTarget(target.element) else { return targetJSON(["status": "unverified"]) }
    guard let value = targetAttr(target.element, kAXValueAttribute as String) as? String else { return targetJSON(["status": "unverified"]) }
    if value == expected { target.verified = true }
    return targetJSON(["status": value == expected ? "verified" : "pending"])
}

/// Only the inserted region may change. Compare exact prefix/suffix locally;
/// never send the surrounding field or its changes over the native bridge.
/// Size limits bound this optional learning feature, not dictation duration.
func observedInsertion(_ original: String, _ range: CFRange, _ current: String) -> String? {
    guard (original as NSString).length <= 1_000_000, (current as NSString).length <= 1_000_000,
          expectedInsertion(original, range, "") != nil else { return nil }
    let old = original as NSString, next = current as NSString
    let suffixLength = old.length - range.location - range.length
    let length = next.length - range.location - suffixLength
    guard length >= 0, length <= 100_000,
          next.substring(to: range.location) == old.substring(to: range.location),
          next.substring(from: range.location + length) == old.substring(from: range.location + range.length),
          expectedInsertion(current, CFRange(location: range.location, length: length), "") != nil else { return nil }
    return next.substring(with: NSRange(location: range.location, length: length))
}

@_cdecl("beginInputObservation")
public func beginInputObservation(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let textPtr, let target = inputTargets[String(cString: tokenPtr)], target.verified,
          target.insertedText == String(cString: textPtr), !target.webRedacted,
          let original = target.value, let range = target.range, let expected = target.expected,
          observedInsertion(original, range, expected) == target.insertedText else { return targetJSON(["ok": false]) }
    target.observingSince = ProcessInfo.processInfo.systemUptime
    return targetJSON(["ok": true])
}

@_cdecl("readInputObservation")
public func readInputObservation(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], let since = target.observingSince,
          ProcessInfo.processInfo.systemUptime - since < 60 else { return targetJSON(["active": false, "reason": "expired"]) }
    guard AXIsProcessTrusted(), !target.app.isTerminated else { return targetJSON(["active": false, "reason": "unavailable"]) }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else { return targetJSON(["active": false, "reason": "app_changed"]) }
    guard !secureTarget(target.element), let focused = focusedTarget(), CFEqual(focused, target.element) else { return targetJSON(["active": false, "reason": "field_changed"]) }
    let web = targetWebContext(target.element)
    guard !web.redacted, web.urls == target.webUrls else { return targetJSON(["active": false, "reason": "document_changed"]) }
    // The current field is read transiently to reject any change outside the
    // insertion. Nothing from a different target or outside that range returns.
    guard let original = target.value, let range = target.range,
          let current = targetAttr(target.element, kAXValueAttribute as String) as? String,
          let text = observedInsertion(original, range, current), let selected = targetRange(target.element),
          selected.location >= range.location, selected.length >= 0,
          selected.location <= range.location + (text as NSString).length,
          selected.length <= range.location + (text as NSString).length - selected.location else { return targetJSON(["active": false, "reason": "range_changed"]) }
    return targetJSON(["active": true, "text": text])
}

@_cdecl("releaseInputTarget")
public func releaseInputTarget(_ tokenPtr: UnsafePointer<CChar>?) {
    guard let tokenPtr else { return }
    inputTargets.removeValue(forKey: String(cString: tokenPtr))
}

// Called through Koffi's async API. UI mutations execute on the AppKit main
// queue after the initiating JavaScript callback has unwound, avoiding nested
// Electron event dispatch inside a synchronous FFI call.
private func onTargetMain(_ action: () -> UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    if Thread.isMainThread { return action() }
    return DispatchQueue.main.sync(execute: action)
}
@_cdecl("prepareInputTarget")
public func prepareInputTarget(_ token: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return onTargetMain { prepareInputTargetOnMain(token) }
}
@_cdecl("commitInputTarget")
public func commitInputTarget(_ token: UnsafePointer<CChar>?, _ text: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return onTargetMain { commitInputTargetOnMain(token, text) }
}
