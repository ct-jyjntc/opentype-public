import AppKit
import ApplicationServices

private func targetAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func targetAttrResult(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
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
private func targetRangeValue(_ range: CFRange) -> AXValue? {
    var value = range
    return withUnsafePointer(to: &value) { AXValueCreate(.cfRange, UnsafeRawPointer($0)) }
}
private struct ContextEditSide {
    let original: String
    let replacement: String
}
private struct ContextEdit {
    let before: ContextEditSide?
    let after: ContextEditSide?
}
private func isContextEditCharacter(_ scalar: UnicodeScalar) -> Bool {
    switch scalar.value {
    case 0x3002, 0xFF01, 0xFF1F, 0x2E, 0x21, 0x3F, 0x2C, 0xFF0C, 0x3001,
         0x3B, 0xFF1B, 0x3A, 0xFF1A, 0x9, 0xA, 0xB, 0xC, 0xD, 0x20,
         0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    case 0x2000...0x200A:
        return true
    default:
        return false
    }
}
private func contextEditSide(_ value: Any?) -> ContextEditSide? {
    guard let value = value as? [String: Any], let original = value["original"] as? String,
          let replacement = value["replacement"] as? String,
          original != replacement, !original.isEmpty,
          (original as NSString).length <= 8, (replacement as NSString).length <= 8,
          original.unicodeScalars.allSatisfy(isContextEditCharacter),
          replacement.unicodeScalars.allSatisfy(isContextEditCharacter) else { return nil }
    return ContextEditSide(original: original, replacement: replacement)
}
private func parseContextEdit(_ json: String) -> ContextEdit? {
    guard let data = json.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data),
          let dictionary = object as? [String: Any],
          Set(dictionary.keys).isSubset(of: ["before", "after"]) else { return nil }
    if dictionary["before"] != nil, contextEditSide(dictionary["before"]) == nil { return nil }
    if dictionary["after"] != nil, contextEditSide(dictionary["after"]) == nil { return nil }
    return ContextEdit(before: dictionary["before"].flatMap(contextEditSide), after: dictionary["after"].flatMap(contextEditSide))
}
private func contextWordUnit(_ value: unichar) -> Bool {
    if (value >= 0xD800 && value <= 0xDFFF) || value == 0x5F { return true }
    guard let scalar = UnicodeScalar(value) else { return true }
    return CharacterSet.alphanumerics.contains(scalar)
}
private func safeNaturalContextEdit(_ value: String, _ range: CFRange, _ text: String, _ edit: ContextEdit) -> Bool {
    guard range.length == 0, let before = edit.before, edit.after == nil,
          (before.original as NSString).length == 1, (before.replacement as NSString).length == 1,
          let original = before.original.utf16.first, let replacement = before.replacement.utf16.first,
          [0x002E, 0x0021, 0x003F, 0x3002, 0xFF01, 0xFF1F].contains(original),
          [0x002C, 0xFF0C, 0x3001].contains(replacement) else { return false }
    guard !text.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) }) else { return false }
    let source = value as NSString
    guard range.location >= 1, range.location <= source.length,
          source.substring(with: NSRange(location: range.location - 1, length: 1)) == before.original else { return false }
    let leftUnit = range.location >= 2 ? source.character(at: range.location - 2) : 0
    let leftIsDigit = UnicodeScalar(leftUnit).map { CharacterSet.decimalDigits.contains($0) } ?? false
    let rightUnit = range.location < source.length ? source.character(at: range.location) : nil
    let rightIsDigit: Bool
    if let rightUnit, let scalar = UnicodeScalar(rightUnit) { rightIsDigit = CharacterSet.decimalDigits.contains(scalar) }
    else { rightIsDigit = false }
    if leftIsDigit || rightIsDigit || (original == 0x002E && contextWordUnit(leftUnit) && rightUnit.map(contextWordUnit) == true) { return false }
    if original == 0x003F && contextWordUnit(leftUnit) && rightUnit.map(contextWordUnit) == true { return false }
    guard contextWordUnit(leftUnit), let firstBody = text.utf16.first, contextWordUnit(firstBody) else { return false }

    // Omit the candidate mark, but inspect the complete captured line so
    // operators elsewhere in a ternary or expression still block the edit.
    let combined = source.substring(to: range.location - 1) + text + source.substring(from: range.location)
    let combinedSource = combined as NSString
    let combinedCaret = range.location - 1 + (text as NSString).length
    var lineStart = combinedCaret
    while lineStart > 0 {
        let unit = combinedSource.character(at: lineStart - 1)
        if unit == 0x000A || unit == 0x000D { break }
        lineStart -= 1
    }
    var lineEnd = combinedCaret
    while lineEnd < combinedSource.length {
        let unit = combinedSource.character(at: lineEnd)
        if unit == 0x000A || unit == 0x000D { break }
        lineEnd += 1
    }
    let line = combinedSource.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart))
    let hazards = CharacterSet(charactersIn: ":;()[]{}<>$%&|+-*/\\`_@#=~\"'")
    if line.rangeOfCharacter(from: hazards) != nil || line.localizedCaseInsensitiveContains("www.") { return false }
    let codePrefix = try? NSRegularExpression(pattern: "^\\s*(?:if|else|return|const|let|var|function|class|import|export|async|await|throw|try|catch|switch|case|for|while|new|def|fn|public|private|static)\\b")
    if codePrefix?.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil { return false }
    let marker = try? NSRegularExpression(pattern: "^\\s*(?:#{1,6}\\s|>\\s|[-+*]\\s|\\d{1,3}[.)]\\s)")
    if marker?.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil { return false }
    if original == 0x002E {
        var sourceLineStart = range.location - 1
        while sourceLineStart > 0 {
            let unit = source.character(at: sourceLineStart - 1)
            if unit == 0x000A || unit == 0x000D { break }
            sourceLineStart -= 1
        }
        let leftLine = source.substring(with: NSRange(location: sourceLineStart, length: range.location - 1 - sourceLineStart))
        let numbered = try? NSRegularExpression(pattern: "^\\s*\\d{1,3}$")
        if numbered?.firstMatch(in: leftLine, range: NSRange(location: 0, length: (leftLine as NSString).length)) != nil { return false }
    }
    return true
}
private func targetJSON(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let string = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(string)
}
private func contextSubstring(_ source: NSString, range: NSRange) -> String {
    var start = max(0, min(range.location, source.length))
    var end = max(start, min(range.location + range.length, source.length))
    if start > 0, start < source.length, (0xDC00...0xDFFF).contains(source.character(at: start)) { start -= 1 }
    if end > 0, end < source.length,
       (0xD800...0xDBFF).contains(source.character(at: end - 1)),
       (0xDC00...0xDFFF).contains(source.character(at: end)) { end += 1 }
    return source.substring(with: NSRange(location: start, length: end - start))
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
func focusedTarget(app: NSRunningApplication, diagnostics: Bool = true) -> AXUIElement? {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          let element = focusedElement(app: app, diagnostics: diagnostics).element else { return nil }
    return editableTarget(element)
}

/// Read the current system focus. Callers outside capture must never wait or
/// mutate another app's accessibility settings.
private struct FocusResult {
    let element: AXUIElement?
    let error: AXError
    let source: String
    let globalError: AXError?
    let appError: AXError?
    var forcedAX = false
    var bootstrapAttempted = false
    var bootstrapError: Int?
    var initialFocusError: Int
    var focusRetries = 0
}
private func addFocusDiagnostics(_ focus: FocusResult, to data: inout [String: Any]) {
    data["focusError"] = focus.error.rawValue
    data["focusSource"] = focus.source
    if let globalError = focus.globalError { data["globalFocusError"] = globalError.rawValue }
    if let appError = focus.appError { data["appFocusError"] = appError.rawValue }
    data["focusReadable"] = focus.element != nil
    data["initialFocusError"] = focus.initialFocusError
    data["focusRetries"] = focus.focusRetries
    data["axBootstrapAttempted"] = focus.bootstrapAttempted
    if let bootstrapError = focus.bootstrapError { data["axBootstrapError"] = bootstrapError }
    if focus.forcedAX { data["axForced"] = true }
}
private func focusAttribute(on element: AXUIElement) -> (element: AXUIElement?, error: AXError) {
    AXUIElementSetMessagingTimeout(element, 0.1)
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &value)
    return (error == .success ? targetElement(value) : nil, error)
}
private func windowFocusedElement(app: NSRunningApplication) -> AXUIElement? {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = targetElement(targetAttr(application, kAXFocusedWindowAttribute as String)) else { return nil }
    var queue: [(AXUIElement, Int)] = [(window, 0)], visited = 0
    while visited < queue.count && visited < 128 {
        let (node, depth) = queue[visited]; visited += 1
        let direct = focusAttribute(on: node)
        if let focused = direct.element { return focused }
        let role = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role),
           targetAttr(node, kAXFocusedAttribute as String) as? Bool == true { return node }
        // Inspect focus and structure only. Never infer focus from arbitrary
        // editable children or read neighbouring field values.
        if depth < 16, let children = targetAttr(node, kAXChildrenAttribute as String) as? [AXUIElement] {
            queue.append(contentsOf: children.prefix(max(0, 128 - queue.count)).map { ($0, depth + 1) })
        }
    }
    return nil
}
/// Query the known foreground process first. System-wide focus can transiently
/// return noValue even while the app exposes its current focused element.
/// Accept app focus only when AX confirms it belongs to that exact process;
/// otherwise fall back to the system-wide value and retain the caller's PID
/// checks before capture can become an insertion target.
private func focusedElement(app: NSRunningApplication?, diagnostics: Bool = true) -> FocusResult {
    var appError: AXError?
    if let app, NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
        let appFocus = focusAttribute(on: AXUIElementCreateApplication(app.processIdentifier))
        appError = appFocus.error
        if let element = appFocus.element {
            var pid: pid_t = 0
            if AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier {
                // Keep the app result authoritative, while sampling the global
                // error for diagnostics so app-first successes explain why
                // they differ from the previous system-only path.
                let globalDiagnostic = diagnostics ? focusAttribute(on: AXUIElementCreateSystemWide()).error : nil
                return FocusResult(element: element, error: .success, source: "application", globalError: globalDiagnostic,
                                   appError: appFocus.error, initialFocusError: Int(appFocus.error.rawValue))
            }
        }
    }
    let global = focusAttribute(on: AXUIElementCreateSystemWide())
    if let element = global.element {
        return FocusResult(element: element, error: .success, source: "system", globalError: global.error,
                           appError: appError, initialFocusError: Int(appError?.rawValue ?? global.error.rawValue))
    }
    if let app, global.error == .noValue,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
       let element = windowFocusedElement(app: app) {
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier {
            return FocusResult(element: element, error: .success, source: "window", globalError: global.error,
                               appError: appError, initialFocusError: Int(appError?.rawValue ?? global.error.rawValue))
        }
    }
    return FocusResult(element: nil, error: global.error, source: "none", globalError: global.error,
                       appError: appError, initialFocusError: Int(appError?.rawValue ?? global.error.rawValue))
}

/// Context only: Electron hides its AX tree until AXManualAccessibility is set.
/// Ask once without waiting, so later reads (and the next dictation) can see
/// the field. Delivery never depends on this; see commitInputTargetOnMain.
private func readFocusForContext(app: NSRunningApplication) -> FocusResult {
    var focus = focusedElement(app: app)
    if focus.element == nil, focus.globalError == .noValue {
        let error = AXUIElementSetAttributeValue(AXUIElementCreateApplication(app.processIdentifier), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        focus.bootstrapAttempted = true
        if error != .success { focus.bootstrapError = Int(error.rawValue) }
    }
    return focus
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
    /// nil for an app-level target: the app owns keyboard focus but does not
    /// expose its focused field through Accessibility (Chromium before its tree
    /// is built, games, Java/Qt/terminal views). Delivery then gates only on the
    /// frontmost process, like an ordinary keyboard paste, and is unverified.
    let element: AXUIElement?
    let window: AXUIElement?
    let value: String?
    let range: CFRange?
    var expected: String?
    var submitted = false
    let webUrls: [String]
    let webRedacted: Bool
    init(app: NSRunningApplication) {
        self.app = app; element = nil; window = nil; value = nil; range = nil
        webUrls = []; webRedacted = true
    }
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
        if let element, secureTarget(element) { return "injection_secure_target" }
        return nil
    }
    /// The only delivery gate: the app that was frontmost at capture is still
    /// frontmost. Its own keyboard focus decides where the text lands.
    func ready() -> String? {
        if let error = valid() { return error }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier ? nil : "injection_app_changed"
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
func targetWebContext(_ element: AXUIElement, maximumDepth: Int = 64, messagingTimeout: Float? = nil) -> (urls: [String], redacted: Bool) {
    var current: AXUIElement? = element, urls: [String] = [], web = false
    for _ in 0..<maximumDepth {
        guard let node = current else { return (urls, web && urls.isEmpty) }
        if let messagingTimeout { AXUIElementSetMessagingTimeout(node, messagingTimeout) }
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
    let focus = focusedElement(app: app)
    addFocusDiagnostics(focus, to: &data)
    if let app { data["frontMatches"] = front?.processIdentifier == app.processIdentifier }
    guard let node = element ?? focus.element else { return data }
    data["role"] = targetAttr(node, kAXRoleAttribute as String) as? String ?? ""
    var pid: pid_t = 0
    data["pidError"] = AXUIElementGetPid(node, &pid).rawValue
    if app == nil { data["targetPid"] = Int(pid) }
    if let focus = focus.element { data["focusMatches"] = CFEqual(focus, node) }
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

private func captureTarget(_ allowReadOnlySelection: Bool, expectedPID: pid_t? = nil) -> UnsafeMutablePointer<CChar>? {
    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = ["appName": app?.localizedName ?? "", "bundleId": app?.bundleIdentifier ?? "", "pid": Int(app?.processIdentifier ?? 0)]
    guard AXIsProcessTrusted() else { result["diagnostics"] = targetDiagnostics(app: app); result["reason"] = "injection_permission"; return targetJSON(result) }
    guard let app else { result["diagnostics"] = targetDiagnostics(app: app); result["reason"] = "injection_front_app_missing"; return targetJSON(result) }
    if let expectedPID, app.processIdentifier != expectedPID {
        result["reason"] = "injection_app_changed"; result["contextRedacted"] = true
        return targetJSON(result)
    }
    // Best effort: the focused field only adds context, selection and later
    // verification. Failing to read it never blocks delivery.
    let focus = readFocusForContext(app: app)
    var field: AXUIElement?
    if let focused = focus.element {
        var pid: pid_t = 0
        if AXUIElementGetPid(focused, &pid) == .success, pid == app.processIdentifier { field = focused }
    }
    var diagnostics = targetDiagnostics(field, app: app)
    addFocusDiagnostics(focus, to: &diagnostics)
    result["diagnostics"] = diagnostics
    result["contextRedacted"] = true
    result["canVerify"] = false
    if let field, secureTarget(field) { result["reason"] = "injection_secure_target"; return targetJSON(result) }
    let editable = field.flatMap { editableTarget($0) }
    if let element = editable ?? field {
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
    }
    let redacted = result["contextRedacted"] as? Bool ?? true
    // Question mode keeps its old contract: a read-only selection is context,
    // not a place to paste the answer.
    if allowReadOnlySelection && editable == nil {
        result["reason"] = "injection_target_not_editable"
        if !redacted, let field, let text = selectedTargetText(field), !text.isEmpty { result["selectedText"] = text; result["selectionReadOnly"] = true }
        return targetJSON(result)
    }
    guard inputTargets.count < 16 else { result["reason"] = "injection_target_capacity"; return targetJSON(result) }
    let target = editable.map { InputTarget(app: app, element: $0) } ?? InputTarget(app: app)
    if let value = target.value, let range = target.range {
        result["canVerify"] = expectedInsertion(value, range, "") != nil
    }
    let token = UUID().uuidString
    inputTargets[token] = target; result["token"] = token
    if !redacted, let value = target.value, let range = target.range, expectedInsertion(value, range, "") != nil {
        let source = value as NSString
        result["selectedText"] = source.substring(with: NSRange(location: range.location, length: range.length))
        let start = max(0, range.location - 800), end = min(source.length, range.location + range.length + 400)
        result["contextText"] = contextSubstring(source, range: NSRange(location: start, length: min(2000, end - start)))
        result["contextBefore"] = contextSubstring(source, range: NSRange(location: max(0, range.location - 800), length: min(800, range.location)))
        result["contextSelection"] = contextSubstring(source, range: NSRange(location: range.location, length: min(400, range.length)))
        result["contextAfter"] = contextSubstring(source, range: NSRange(location: range.location + range.length,
            length: min(400, source.length - range.location - range.length)))
    }
    return targetJSON(result)
}

@_cdecl("captureInputTarget")
public func captureInputTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(false) }
@_cdecl("captureCommandTarget")
public func captureCommandTarget() -> UnsafeMutablePointer<CChar>? { captureTarget(true) }
@_cdecl("captureInputTargetForProcess")
public func captureInputTargetForProcess(_ expectedPID: Int32, _ allowReadOnlySelection: Int32) -> UnsafeMutablePointer<CChar>? {
    captureTarget(allowReadOnlySelection != 0, expectedPID: expectedPID)
}

private func prepareInputTargetOnMain(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], !target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    // Never activate or refocus: if the user moved to another app, the text
    // stays saved instead of being pasted somewhere they are not looking.
    if let reason = target.ready() { return targetJSON(["reason": reason]) }
    return targetJSON(["ok": true])
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
    if let value = target.value, let range = target.range, let expected = expectedInsertion(value, range, text) {
        target.expected = expected
    }
    target.submitted = true
    return nil
}

private enum ContextPreparation {
    case ready(ContextInjection)
    /// `selected` is the expanded range this delivery may have left selected.
    case refused(String, selected: CFRange? = nil)
}
private struct ContextInjection {
    let strictTarget: TextInjector.StrictInputTarget
    let payload: String
    let applied: Bool
    let originalRange: CFRange
    let reason: String?
}

/// `checkDocument` adds the ancestor URL walk, which is costly on the main thread;
/// the injector repeats it once right before the paste.
private func contextFieldMatches(_ target: InputTarget, value: String, checkDocument: Bool) -> Bool {
    guard target.ready() == nil, let element = target.element else { return false }
    AXUIElementSetMessagingTimeout(element, 0.1)
    let currentWindow = targetElement(targetAttr(element, kAXWindowAttribute as String))
    guard let expectedWindow = target.window, let currentWindow, CFEqual(expectedWindow, currentWindow),
          let focused = focusedTarget(app: target.app, diagnostics: false), CFEqual(focused, element),
          targetAttr(element, kAXValueAttribute as String) as? String == value else { return false }
    guard checkDocument else { return true }
    let currentWeb = targetWebContext(element, messagingTimeout: 0.1)
    return currentWeb.urls == target.webUrls && currentWeb.redacted == target.webRedacted
}
private func currentContextMatches(_ target: InputTarget, value: String, range: CFRange, checkDocument: Bool = false) -> Bool {
    guard contextFieldMatches(target, value: value, checkDocument: checkDocument), let element = target.element,
          let currentRange = targetRange(element), currentRange.location == range.location,
          currentRange.length == range.length else { return false }
    return true
}

/// Chromium applies an AX selection change asynchronously; poll briefly for it.
private func waitForRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
    for attempt in 0..<10 {
        if let current = targetRange(element), current.location == range.location, current.length == range.length { return true }
        if attempt < 9 { usleep(20_000) }
    }
    return false
}

private func prepareBodyOnlyContextFallback(_ target: InputTarget, text: String, reason: String) -> ContextPreparation {
    guard currentContextMatches(target, value: target.value ?? "", range: target.range ?? CFRange(location: -1, length: -1)),
          let element = target.element, let value = target.value, let range = target.range,
          let expected = expectedInsertion(value, range, text) else { return .refused("stale") }
    target.expected = expected
    target.submitted = true
    return .ready(ContextInjection(
        strictTarget: TextInjector.StrictInputTarget(element: element, processID: target.app.processIdentifier,
                                                     value: value, range: range, window: target.window,
                                                     documentURLs: target.webUrls, webRedacted: target.webRedacted),
        payload: text, applied: false, originalRange: range, reason: reason
    ))
}

private func prepareContextEdit(_ token: String, _ text: String, _ editJSON: String) -> ContextPreparation {
    guard let target = inputTargets[token] else { return .refused("injection_target_unavailable") }
    if target.submitted { return .refused("already_sent") }
    if let reason = target.ready() { return .refused(reason) }
    guard !text.isEmpty else { return .refused("injection_failed") }
    guard let element = target.element, let value = target.value, let range = target.range else { return .refused("unsupported") }
    guard currentContextMatches(target, value: value, range: range, checkDocument: true) else { return .refused("stale") }
    guard let edit = parseContextEdit(editJSON) else { return prepareBodyOnlyContextFallback(target, text: text, reason: "invalid") }
    if edit.before == nil && edit.after == nil { return prepareBodyOnlyContextFallback(target, text: text, reason: "body_only") }
    guard safeNaturalContextEdit(value, range, text, edit) else { return prepareBodyOnlyContextFallback(target, text: text, reason: "unsafe_context") }
    if target.webRedacted { return prepareBodyOnlyContextFallback(target, text: text, reason: "unsupported") }
    let source = value as NSString
    let beforeLength = ((edit.before?.original ?? "") as NSString).length
    let afterLength = ((edit.after?.original ?? "") as NSString).length
    guard range.location >= beforeLength, range.location + range.length <= source.length - afterLength else { return prepareBodyOnlyContextFallback(target, text: text, reason: "invalid") }
    if let before = edit.before,
       source.substring(with: NSRange(location: range.location - beforeLength, length: beforeLength)) != before.original { return prepareBodyOnlyContextFallback(target, text: text, reason: "invalid") }
    if let after = edit.after,
       source.substring(with: NSRange(location: range.location + range.length, length: afterLength)) != after.original { return prepareBodyOnlyContextFallback(target, text: text, reason: "invalid") }
    let expandedRange = CFRange(location: range.location - beforeLength, length: range.length + beforeLength + afterLength)
    guard expectedInsertion(value, expandedRange, "") != nil else { return prepareBodyOnlyContextFallback(target, text: text, reason: "invalid") }
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success,
          settable.boolValue else { return prepareBodyOnlyContextFallback(target, text: text, reason: "unsupported") }
    guard let expandedValue = targetRangeValue(expandedRange) else {
        return prepareBodyOnlyContextFallback(target, text: text, reason: "unsupported")
    }
    let setResult = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, expandedValue)
    if setResult == .attributeUnsupported {
        guard currentContextMatches(target, value: value, range: range) else { return .refused("stale") }
        return prepareBodyOnlyContextFallback(target, text: text, reason: "unsupported")
    }
    // A timed-out set may still apply, so every refusal from here on names the expanded range.
    guard setResult == .success else { return .refused("stale", selected: expandedRange) }
    guard waitForRange(element, expandedRange),
          currentContextMatches(target, value: value, range: expandedRange) else { return .refused("stale", selected: expandedRange) }
    let payload = (edit.before?.replacement ?? "") + text + (edit.after?.replacement ?? "")
    guard let expected = expectedInsertion(value, expandedRange, payload) else { return .refused("invalid", selected: expandedRange) }
    target.expected = expected
    target.submitted = true
    return .ready(ContextInjection(
        strictTarget: TextInjector.StrictInputTarget(element: element, processID: target.app.processIdentifier,
                                                     value: value, range: expandedRange, window: target.window,
                                                     documentURLs: target.webUrls, webRedacted: target.webRedacted),
        payload: payload, applied: edit.before != nil || edit.after != nil, originalRange: range, reason: nil
    ))
}

/// True when the field is back at (or never left) the captured selection, so a
/// plain delivery cannot replace neighbouring text. Restores only while the
/// same field still holds the same value with exactly `selected` selected;
/// focus and document checks are deliberately not required here.
private func restoreContextSelection(_ token: String, selected: CFRange?) -> Bool {
    guard let selected else { return true }
    guard let target = inputTargets[token], let element = target.element, let value = target.value, let original = target.range,
          targetAttr(element, kAXValueAttribute as String) as? String == value,
          let current = targetRange(element) else { return false }
    // Write the original back even when it already reads as original: a timed-out
    // or cached select may still apply, and this write is queued after it.
    let atOriginal = current.location == original.location && current.length == original.length
    let atSelected = current.location == selected.location && current.length == selected.length
    guard atOriginal || atSelected,
          let originalValue = targetRangeValue(original),
          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, originalValue) == .success else { return false }
    return waitForRange(element, original)
}

/// One shared injector: VocaMac serializes every clipboard delivery through it.
private let textInjector = TextInjector()

/// Receives the first outcome of one delivery; later reports are ignored.
private final class DeliveryWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var outcome: DeliveryOutcome?
    func report(_ value: DeliveryOutcome) {
        lock.lock(); defer { lock.unlock() }
        guard outcome == nil else { return }
        outcome = value
        done.signal()
    }
    func wait(seconds: Double) -> DeliveryOutcome? {
        _ = done.wait(timeout: .now() + seconds)
        lock.lock(); defer { lock.unlock() }
        return outcome
    }
}

/// Token validation runs on main; delivery is VocaMac's TextInjector, which
/// writes Accessibility off the main thread and pastes on it. Koffi calls this
/// from a worker thread, which waits for the outcome without blocking AppKit.
private func commitInputTargetThroughInjector(_ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    if let refused = onTargetMain({ commitInputTargetOnMain(tokenPtr, textPtr) }) { return refused }
    guard let tokenPtr, let textPtr else { return targetJSON(["reason": "injection_target_unavailable"]) }
    let token = String(cString: tokenPtr), text = String(cString: textPtr)
    let pid = onTargetMain { inputTargets[token]?.app.processIdentifier } ?? 0
    let waiter = DeliveryWaiter()
    textInjector.inject(text: text, preserveClipboard: true, expectedProcessID: pid, report: { waiter.report($0) })
    // The main thread cannot wait for work it has to run itself.
    if Thread.isMainThread { return targetJSON(["submitted": true, "method": "unknown"]) }
    // A queued delivery waits for the previous paste (up to its 2s receipt timeout).
    switch waiter.wait(seconds: 8) {
    case .accessibility: return targetJSON(["submitted": true, "method": "accessibility"])
    case .uncertain: return targetJSON(["submitted": true, "method": "accessibility", "uncertain": true])
    case .pasted: return targetJSON(["submitted": true, "method": "clipboard"])
    case .failed(let reason):
        onTargetMain { inputTargets[token]?.submitted = false }
        return targetJSON(["reason": reason])
    case nil: return targetJSON(["submitted": true, "method": "unknown", "uncertain": true])
    }
}

private func commitInputTargetWithContextEditThroughInjector(
    _ tokenPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?, _ editPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let textPtr, let editPtr else { return targetJSON(["reason": "injection_target_unavailable", "contextEditApplied": false]) }
    let token = String(cString: tokenPtr), text = String(cString: textPtr), editJSON = String(cString: editPtr)
    switch onTargetMain({ prepareContextEdit(token, text, editJSON) }) {
    case .refused(let reason, let selected):
        if reason == "already_sent" {
            return targetJSON(["submitted": true, "uncertain": true, "reason": "injection_already_sent", "contextEditReason": "unknown"])
        }
        let retryable = onTargetMain { restoreContextSelection(token, selected: selected) }
        return targetJSON(["reason": "injection_target_changed", "contextEditApplied": false, "contextEditReason": reason, "retryable": retryable])
    case .ready(let injection):
        let waiter = DeliveryWaiter()
        textInjector.inject(text: injection.payload, preserveClipboard: true, strictTarget: injection.strictTarget) { waiter.report($0) }
        if Thread.isMainThread {
            return targetJSON(["submitted": true, "method": "unknown", "uncertain": true, "contextEditReason": "uncertain"])
        }
        switch waiter.wait(seconds: 8) {
        case .accessibility:
            var response: [String: Any] = ["submitted": true, "method": "accessibility", "contextEditApplied": injection.applied]
            if let reason = injection.reason { response["contextEditReason"] = reason }
            return targetJSON(response)
        case .pasted:
            var response: [String: Any] = ["submitted": true, "method": "clipboard", "contextEditApplied": injection.applied]
            if let reason = injection.reason { response["contextEditReason"] = reason }
            return targetJSON(response)
        case .uncertain:
            return targetJSON(["submitted": true, "method": "accessibility", "uncertain": true, "contextEditReason": "uncertain"])
        case .failed(let reason):
            let retryable = onTargetMain {
                let restored = restoreContextSelection(token, selected: injection.strictTarget.range)
                if let target = inputTargets[token] {
                    target.submitted = false
                    target.expected = nil
                }
                return restored
            }
            return targetJSON(["reason": reason, "contextEditApplied": false, "contextEditReason": "delivery_failed", "retryable": retryable])
        case nil:
            return targetJSON(["submitted": true, "method": "unknown", "uncertain": true, "contextEditReason": "uncertain"])
        }
    }
}

func inputReadPending(_ error: AXError) -> Bool { error == .cannotComplete || error == .noValue }
func inputVerificationStatus(_ error: AXError, _ value: String?, _ expected: String) -> String {
    if inputReadPending(error) { return "pending" }
    guard error == .success, let value else { return "unverified" }
    return value == expected ? "verified" : "pending"
}

@_cdecl("verifyInputTarget")
public func verifyInputTarget(_ tokenPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenPtr, let target = inputTargets[String(cString: tokenPtr)], target.submitted else { return targetJSON(["reason": "injection_target_unavailable"]) }
    guard let expected = target.expected, let element = target.element else { return targetJSON(["status": "unverified"]) }
    guard !target.app.isTerminated, !secureTarget(element) else { return targetJSON(["status": "unverified"]) }
    let (readError, rawValue) = targetAttrResult(element, kAXValueAttribute as String)
    let status = inputVerificationStatus(readError, rawValue as? String, expected)
    guard readError == .success else { return targetJSON(["status": status, "ax_error": readError.rawValue]) }
    return targetJSON(["status": status])
}

@_cdecl("releaseInputTarget")
public func releaseInputTarget(_ tokenPtr: UnsafePointer<CChar>?) {
    guard let tokenPtr else { return }
    inputTargets.removeValue(forKey: String(cString: tokenPtr))
}

// Called through Koffi's async API. UI mutations execute on the AppKit main
// queue after the initiating JavaScript callback has unwound, avoiding nested
// Electron event dispatch inside a synchronous FFI call.
private func onTargetMain<T>(_ action: () -> T) -> T {
    if Thread.isMainThread { return action() }
    return DispatchQueue.main.sync(execute: action)
}
@_cdecl("prepareInputTarget")
public func prepareInputTarget(_ token: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return onTargetMain { prepareInputTargetOnMain(token) }
}
@_cdecl("commitInputTarget")
public func commitInputTarget(_ token: UnsafePointer<CChar>?, _ text: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return commitInputTargetThroughInjector(token, text)
}
@_cdecl("commitInputTargetWithContextEdit")
public func commitInputTargetWithContextEdit(_ token: UnsafePointer<CChar>?, _ text: UnsafePointer<CChar>?, _ editJSON: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    return commitInputTargetWithContextEditThroughInjector(token, text, editJSON)
}
