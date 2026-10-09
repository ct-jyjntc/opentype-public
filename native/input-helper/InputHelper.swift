// 语音输入法核心原生库：文本注入 + 选区读取 + 剪贴板存档
// 编译：swiftc -emit-library -O -o build/libInputHelper.dylib InputHelper.swift
// 所有导出函数使用 @_cdecl 保证 C ABI，供 Node 侧 koffi 直接调用。

import Foundation
import AppKit
import Carbon.HIToolbox

// MARK: - 字符串内存管理
// 返回给 Node 的字符串统一用 strdup 分配，由 JS 侧调用 freeString 释放，避免跨运行时内存所有权混乱。

@_cdecl("freeString")
public func freeString(_ ptr: UnsafeMutablePointer<CChar>?) {
    guard let ptr else { return }
    free(ptr)
}

private func cString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    return strdup(s)
}

// MARK: - 剪贴板存档

/// 保存剪贴板全部条目，用于注入后还原用户原有内容。
private func archivePasteboard() -> [[String: Data]] {
    return archivePasteboard(NSPasteboard.general)
}

private func restorePasteboard(_ archive: [[String: Data]]) {
    restorePasteboard(archive, to: NSPasteboard.general)
}

@_cdecl("savePasteboard")
public func savePasteboard() -> UnsafeMutablePointer<CChar>? {
    let archive = archivePasteboard()
    let json = archive.map { entry in entry.mapValues { $0.base64EncodedString() } }
    guard let data = try? JSONSerialization.data(withJSONObject: json),
          let str = String(data: data, encoding: .utf8) else { return cString("[]") }
    return cString(str)
}

@_cdecl("restorePasteboard")
public func restorePasteboard(_ jsonPtr: UnsafePointer<CChar>?) {
    guard let jsonPtr else { return }
    let json = String(cString: jsonPtr)
    guard let data = json.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return }
    let archive: [[String: Data]] = raw.map { entry in
        var out: [String: Data] = [:]
        for (k, v) in entry { out[k] = Data(base64Encoded: v) ?? Data() }
        return out
    }
    restorePasteboard(archive)
}

// MARK: - 文本注入

private let pasteboardRestorer = PasteboardRestorer(NSPasteboard.general)

/// 通过剪贴板 + Cmd+V 注入文本。
/// 这是唯一在 Chromium / Electron / 原生 App / 终端里都稳定的方案；
/// 逐字符 CGEvent 注入在中文输入法环境下会被 IME 拦截并乱序。
func pasteViaClipboard(_ text: String, pid: pid_t? = nil) -> Bool {
    guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
    let vKey: CGKeyCode = 0x09  // kVK_ANSI_V

    guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false) else { return false }
    let pb = NSPasteboard.general
    let saved = pasteboardRestorer.capture()
    pb.clearContents()
    guard pb.setString(text, forType: .string) else {
        restorePasteboard(saved)
        return false
    }
    let restoreToken = pasteboardRestorer.didWrite(original: saved)
    down.flags = .maskCommand
    up.flags = .maskCommand
    if let pid { down.postToPid(pid); up.postToPid(pid) }
    else { down.post(tap: .cgAnnotatedSessionEventTap); up.post(tap: .cgAnnotatedSessionEventTap) }

    // 等待目标应用读取；期间用户复制了新内容则保留新内容。
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
        pasteboardRestorer.restoreIfOwned(restoreToken)
    }
    return true
}

@_cdecl("insertText")
public func insertText(_ textPtr: UnsafePointer<CChar>?) -> Int32 {
    guard let textPtr else { return -1 }
    let text = String(cString: textPtr)
    guard !text.isEmpty else { return -2 }
    return pasteViaClipboard(text) ? 0 : -3
}

/// 富文本注入：同时写入 HTML 与纯文本，让支持 HTML 的目标（Word、Notion、邮件客户端）保留格式。
@_cdecl("insertRichText")
public func insertRichText(_ htmlPtr: UnsafePointer<CChar>?, _ textPtr: UnsafePointer<CChar>?) -> Int32 {
    guard let textPtr else { return -1 }
    let text = String(cString: textPtr)
    let html = htmlPtr.map { String(cString: $0) } ?? ""

    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false) else { return -3 }

    let pb = NSPasteboard.general
    let saved = pasteboardRestorer.capture()
    pb.clearContents()
    if !html.isEmpty {
        pb.setString(html, forType: .html)
    }
    guard pb.setString(text, forType: .string) else {
        restorePasteboard(saved)
        return -3
    }
    let restoreToken = pasteboardRestorer.didWrite(original: saved)
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cgAnnotatedSessionEventTap)
    up.post(tap: .cgAnnotatedSessionEventTap)

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
        pasteboardRestorer.restoreIfOwned(restoreToken)
    }
    return 0
}

/// 删除前 n 个字符，用于「回退 AI 润色」与纠正场景。
@_cdecl("deleteBackward")
public func deleteBackward(_ count: Int32) -> Int32 {
    guard count > 0 else { return -1 }
    guard let source = CGEventSource(stateID: .combinedSessionState) else { return -2 }
    for _ in 0..<count {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0x33, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0x33, keyDown: false) else { return -3 }
        down.post(tap: .cgAnnotatedSessionEventTap)
        up.post(tap: .cgAnnotatedSessionEventTap)
        usleep(8_000)
    }
    return 0
}

// MARK: - 选区读取

/// 用 AX API 直读选区。
///
/// 反编译确认真实实现优先走这条路：AXTextMarkerRange 系列 API 能直接拿到
/// 富文本/网页选区，比模拟 Cmd+C 更快且无副作用（不污染剪贴板、不触发
/// 目标应用的复制回调）。部分 Electron 应用 AXSelectedText 返回空，
/// 但 AXTextMarkerRange 仍可用——所以两条路径都要有。
private func selectedTextViaAX() -> String? {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          let element = focused else { return nil }
    let axElement = element as! AXUIElement

    // 优先 AXSelectedText（原生输入框）
    var selected: CFTypeRef?
    if AXUIElementCopyAttributeValue(axElement, kAXSelectedTextAttribute as CFString, &selected) == .success,
       let text = selected as? String, !text.isEmpty {
        return text
    }

    // 退化到 AXTextMarkerRange（网页 / 富文本）
    // 注意：kAXSelectedTextMarkerRangeAttribute 属于 AXTextMarker 私有扩展，
    // 需用字符串字面量而非常量，且需先取 AXStringForTextMarkerRange 求值。
    var markerRange: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axElement, "AXSelectedTextMarkerRange" as CFString, &markerRange) == .success,
          let range = markerRange else { return nil }

    var stringRef: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(
        axElement,
        "AXStringForTextMarkerRange" as CFString,
        range,
        &stringRef
    ) == .success, let text = stringRef as? String, !text.isEmpty else { return nil }
    return text
}

@_cdecl("getSelectedText")
public func getSelectedText() -> UnsafeMutablePointer<CChar>? {
    // 优先 AX 直读：无副作用、不占用剪贴板
    if let viaAX = selectedTextViaAX() {
        return cString(viaAX)
    }

    // 兜底：模拟 Cmd+C
    let pb = NSPasteboard.general
    let saved = archivePasteboard()
    let before = pb.changeCount

    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0x08, keyDown: true),  // kVK_ANSI_C
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0x08, keyDown: false) else { return nil }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cgAnnotatedSessionEventTap)
    up.post(tap: .cgAnnotatedSessionEventTap)

    // 轮询剪贴板变化，最多等 300ms。没有变化说明用户没有选中内容。
    var result: String? = nil
    var copiedChangeCount: Int? = nil
    let deadline = Date().addingTimeInterval(0.3)
    while Date() < deadline {
        if pb.changeCount != before {
            copiedChangeCount = pb.changeCount
            result = pb.string(forType: .string)
            break
        }
        usleep(10_000)
    }
    // No selection/copy means no clipboard mutation to undo.
    if let copiedChangeCount, pb.changeCount == copiedChangeCount { restorePasteboard(saved) }
    guard let text = result, !text.isEmpty else { return nil }
    return cString(text)
}

/// 输入状态：判断当前焦点是否处于可编辑文本域，决定是否允许注入。
@_cdecl("getCurrentInputState")
public func getCurrentInputState() -> UnsafeMutablePointer<CChar>? {
    let app = NSWorkspace.shared.frontmostApplication
    let info: [String: Any] = [
        "bundleId": app?.bundleIdentifier ?? "",
        "appName": app?.localizedName ?? "",
        "pid": Int(app?.processIdentifier ?? 0)
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: info),
          let str = String(data: data, encoding: .utf8) else { return cString("{}") }
    return cString(str)
}
