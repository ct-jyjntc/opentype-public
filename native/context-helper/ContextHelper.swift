// 前台上下文采集：读取光标所在的输入框、其附近文本、以及浏览器页面信息。
// 这是「AI 润色能理解你在写什么」的关键——只把音频给模型是不够的，
// 必须附带当前输入框上下文，模型才能判断该用正式还是口语风格、术语怎么拼。

import Foundation
import AppKit
import ApplicationServices

@_cdecl("freeString")
public func freeString(_ ptr: UnsafeMutablePointer<CChar>?) {
    guard let ptr else { return }
    free(ptr)
}

private func json(_ obj: Any) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let str = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(str)
}

/// 读取元素的指定属性，失败返回 nil。
private func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return err == .success ? value : nil
}

private func stringAttr(_ element: AXUIElement, _ name: String) -> String? {
    return attr(element, name) as? String
}

/// 判断元素是否可见，过滤掉隐藏的辅助节点，否则会采集到大量噪音文本。
private func isVisible(_ element: AXUIElement) -> Bool {
    if let hidden = attr(element, kAXHiddenAttribute as String) as? Bool, hidden { return false }
    if let size = attr(element, kAXSizeAttribute as String) {
        var s = CGSize.zero
        if AXValueGetValue(size as! AXValue, .cgSize, &s), s.width <= 0 || s.height <= 0 { return false }
    }
    return true
}

/// 取焦点元素所在的可编辑文本域。Chromium 系应用会把真实输入框包在 AXWebArea 内，
/// 需要逐层向上找 AXTextArea / AXTextField，找不到就退化为 WebArea。
private func findEditableAncestor(_ element: AXUIElement, maxDepth: Int = 12) -> AXUIElement? {
    var current: AXUIElement? = element
    var depth = 0
    while let node = current, depth < maxDepth {
        let role = stringAttr(node, kAXRoleAttribute as String) ?? ""
        if ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox"].contains(role) {
            return node
        }
        current = attr(node, kAXParentAttribute as String) as! AXUIElement?
        depth += 1
    }
    return nil
}

/// 把采集到的文本片段拼成连贯上下文。
///
/// 反编译还原的真实规则：
/// - 纯空白片段直接丢弃
/// - 相邻两段都是正文（isText）时直接拼接，不插分隔符
///   （AX 树会把同一句话切碎，插换行会把一句话拆成多行）
/// - 其余情况插入换行，区分不同结构节点
public func smartJoinTexts(_ items: [(text: String, isText: Bool)]) -> String {
    var result = ""
    var lastWasText = false
    for item in items {
        let trimmed = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        if lastWasText && item.isText {
            result += item.text
        } else {
            result += "\n"
            result += item.text
        }
        lastWasText = item.isText
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 从光标位置向前/向后收集上下文文本，用于给模型提供写作语境。
private func collectSiblingText(_ element: AXUIElement, limit: Int) -> String {
    var collected: [String] = []
    var total = 0
    if let children = attr(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children {
            if total >= limit { break }
            if !isVisible(child) { continue }
            if let value = stringAttr(child, kAXValueAttribute as String), !value.isEmpty {
                collected.append(value)
                total += value.count
            }
        }
    }
    return collected.joined(separator: "\n")
}

/// 浏览器地址栏与页面标题：判断用户是否在写邮件、文档还是聊天，风格要求完全不同。
private func webInfo(_ element: AXUIElement) -> [String: Any] {
    var out: [String: Any] = [:]
    var current: AXUIElement? = element
    var depth = 0
    while let node = current, depth < 20 {
        let role = stringAttr(node, kAXRoleAttribute as String) ?? ""
        if role == "AXWebArea" {
            if let url = stringAttr(node, kAXURLAttribute as String) { out["url"] = url }
            if let title = stringAttr(node, kAXTitleAttribute as String) { out["title"] = title }
            break
        }
        current = attr(node, kAXParentAttribute as String) as! AXUIElement?
        depth += 1
    }
    return out
}

/// 主入口：返回焦点输入框的完整上下文。
@_cdecl("getFocusedInputInfo")
public func getFocusedInputInfo() -> UnsafeMutablePointer<CChar>? {
    guard AXIsProcessTrusted() else {
        return json(["success": false, "reason": "no_accessibility_permission"])
    }
    let system = AXUIElementCreateSystemWide()
    guard let focused = attr(system, kAXFocusedUIElementAttribute as String) else {
        return json(["success": false, "reason": "no_focused_element"])
    }
    let element = focused as! AXUIElement
    let editable = findEditableAncestor(element) ?? element

    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = [
        "success": true,
        "appName": app?.localizedName ?? "",
        "bundleId": app?.bundleIdentifier ?? "",
        "pid": Int(app?.processIdentifier ?? 0),
        "role": stringAttr(editable, kAXRoleAttribute as String) ?? ""
    ]

    if let value = stringAttr(editable, kAXValueAttribute as String) {
        result["focusedValue"] = String(value.prefix(4000))
    }
    if let selected = stringAttr(editable, kAXSelectedTextAttribute as String) {
        result["selectedText"] = selected
    }
    let contextText = collectSiblingText(editable, limit: 3000)
    if !contextText.isEmpty { result["surroundingText"] = contextText }

    let web = webInfo(editable)
    if !web.isEmpty { result["web"] = web }

    return json(result)
}

/// 应用信息单独导出，浮窗需要显示当前目标应用图标与名称。
@_cdecl("getFocusedAppInfo")
public func getFocusedAppInfo() -> UnsafeMutablePointer<CChar>? {
    let app = NSWorkspace.shared.frontmostApplication
    return json([
        "appName": app?.localizedName ?? "",
        "bundleId": app?.bundleIdentifier ?? "",
        "pid": Int(app?.processIdentifier ?? 0)
    ])
}

/// 需要「向上遍历 DOM 查找 URL」的浏览器清单。
///
/// 动态提取自真实产品（该常量在二进制里是运行时构造的，静态不可读）：
/// 仅 Chromium 与 Safari 两项。它们的内核把 URL 挂在较深的 AX 节点上，
/// 必须从焦点元素逐层向上找 AXWebArea 才能拿到；其余浏览器用更轻量的方式即可。
public let bottomUpURLTraversalWhitelist: [String] = [
    "org.chromium.Chromium",
    "com.apple.Safari"
]

/// 判断是否需要用「向上遍历」这条较重路径获取 URL。
///
/// 注意 @_cdecl 是必需的：`public` 只产出 Swift 符号（带 module 前缀的 mangled name），
/// koffi 按 C 符号名查找，缺少此标记会报 "Cannot find function"。
@_cdecl("needsBottomUpURLTraversal")
public func needsBottomUpURLTraversal(_ bundleIdPtr: UnsafePointer<CChar>?) -> Bool {
    guard let bundleIdPtr else { return false }
    return bottomUpURLTraversalWhitelist.contains(String(cString: bundleIdPtr))
}

/// 判断是否浏览器，用于决定是否采集网页上下文。
///
/// 反编译确认真实实现用 hasPrefix 而非精确相等：同一浏览器常有多个变体
/// bundle id（如 com.google.Chrome.canary），前缀匹配可一并覆盖。
@_cdecl("isBrowserApp")
public func isBrowserApp(_ bundleIdPtr: UnsafePointer<CChar>?) -> Bool {
    guard let bundleIdPtr else { return false }
    let id = String(cString: bundleIdPtr)
    let prefixes = [
        "com.google.Chrome",
        "com.apple.Safari",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
        "org.mozilla.nightly",
        "org.chromium.Chromium",
        "com.brave.Browser",
        "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera",
        "com.duckduckgo.macos.browser",
        "com.kagi.kagimacOS",
        "com.openai.atlas",
        "ai.perplexity.comet"
    ]
    return prefixes.contains { id.hasPrefix($0) }
}
