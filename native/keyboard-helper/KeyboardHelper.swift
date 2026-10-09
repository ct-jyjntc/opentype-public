// 全局键盘监听：实现「按住热键说话、松开结束」的触发模型。
// 必须使用 CGEventTap 而非 NSEvent 全局监听，因为前者能拿到 keyDown/keyUp 成对事件，
// 才能在松开瞬间判定录音结束；同时能识别物理键盘来源，避免外接键盘与内建键盘重复触发。

import Foundation
import Darwin
import AppKit
import Carbon.HIToolbox

/// 回调签名（C ABI），对齐 Typeless 的真实约定：
///   (keyCode, keyName, isKeyDown, isRepeat, extraJson) -> Bool
///
/// 返回 Bool 表示「是否拦截该按键」——当前实现只监听不拦截，恒返回 false。
/// 签名必须与 JS 侧的 koffi proto 完全一致：参数个数或类型不匹配会导致
/// koffi 按错误的类型解析参数（例如把 Int32 当 char* 去 strlen），直接段错误。
public typealias KeyCallback = @convention(c) (
    Int32,                    // keyCode
    UnsafePointer<CChar>?,    // keyName
    Int32,                    // isKeyDown (1/0)
    Int32,                    // isRepeat (1/0)
    UnsafePointer<CChar>?     // extraJson（可选附加数据）
) -> Bool

private var gCallback: KeyCallback?
private var gTap: CFMachPort?
private var gRunLoopSource: CFRunLoopSource?
private var gRunLoop: CFRunLoop?
private var gMonitoringRequested = false
private var gEventCount = 0
private var gLastEventAt = 0
private var gRecoveryCount = 0

@_cdecl("freeString")
public func freeString(_ ptr: UnsafeMutablePointer<CChar>?) {
    guard let ptr else { return }
    free(ptr)
}

/// 将 macOS 虚拟键码转换为可读键名，热键配置以字符串形式存储（跨平台一致）。
/// Fn 键在 macOS 上不产生标准 keyDown/keyUp，而是走 flagsChanged 事件，
/// 对应 CGEventFlags.maskSecondaryFn。必须单独处理，否则 Fn 系列热键完全失效。
private let FN_KEY_CODE: Int32 = 0x3F
private let FN_FLAG: CGEventFlags = .maskSecondaryFn

private let keyCodeToName: [Int32: String] = [
    0x3F: "Fn",
    0x00: "A", 0x0B: "B", 0x08: "C", 0x02: "D", 0x0E: "E", 0x03: "F", 0x05: "G",
    0x04: "H", 0x22: "I", 0x26: "J", 0x28: "K", 0x25: "L", 0x2E: "M", 0x2D: "N",
    0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R", 0x01: "S", 0x11: "T", 0x20: "U",
    0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z",
    0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4",
    0x17: "5", 0x16: "6", 0x1A: "7", 0x1C: "8", 0x19: "9",
    0x31: "Space", 0x24: "Enter", 0x30: "Tab", 0x35: "Escape",
    // 修饰键报物理名（LeftShift/RightShift…）而不是语义名：
    // 渲染层的热键匹配把候选串仅做 toLowerCase 归一（"LeftShift"→"leftshift"），
    // 与按键快照的 keyName 直接比对；报语义名 "Shift" 会让 Fn+LeftShift 永远不匹配。
    // 主进程侧 hotkey.ts 的 canonicalKeyName 会把物理名归一回语义名，不受影响。
    0x3B: "LeftControl", 0x3A: "LeftOption", 0x37: "LeftCommand", 0x38: "LeftShift",
    0x3C: "RightShift", 0x3E: "RightControl", 0x3D: "RightOption", 0x36: "RightCommand",
    0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6",
    0x62: "F7", 0x64: "F8", 0x65: "F9", 0x6D: "F10", 0x67: "F11", 0x6F: "F12"
]

private var physicalFnPressed = false

private func modifierName(_ flags: CGEventFlags) -> [String] {
    var out: [String] = []
    if flags.contains(.maskCommand) { out.append("Command") }
    if flags.contains(.maskControl) { out.append("Control") }
    if flags.contains(.maskAlternate) { out.append("Option") }
    if flags.contains(.maskShift) { out.append("Shift") }
    // Fn 也是合法修饰键（Fn+Space / Fn+LeftShift 组合），漏报会让组合键永远匹配不到
    if flags.contains(.maskSecondaryFn) && physicalFnPressed { out.append("Fn") }
    return out
}

/// 物理修饰键 → 对应的 flags 位。flagsChanged 事件的方向判定用。
private let modifierMaskForKeyCode: [Int64: CGEventFlags] = [
    0x3F: .maskSecondaryFn,                 // Fn
    0x38: .maskShift, 0x3C: .maskShift,     // 左/右 Shift
    0x3A: .maskAlternate, 0x3D: .maskAlternate,  // 左/右 Option
    0x37: .maskCommand, 0x36: .maskCommand,      // 左/右 Command
    0x3B: .maskControl, 0x3E: .maskControl       // 左/右 Control
]

/// 事件回调：把按下/松开事件序列化成 JSON 交给 JS 侧匹配热键。
private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    // A disabled-tap notification carries no usable keyboard event. Re-enable the
    // existing tap without clearing the callback; the watchdog handles failed retries.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if gMonitoringRequested, let tap = gTap {
            physicalFnPressed = false
            CGEvent.tapEnable(tap: tap, enable: true)
            gRecoveryCount += 1
        }
        return Unmanaged.passUnretained(event)
    }
    guard let cb = gCallback else { return Unmanaged.passUnretained(event) }
    gEventCount += 1
    gLastEventAt = Int(Date().timeIntervalSince1970 * 1000)

    let isDown: Bool
    var keyCode = Int32(event.getIntegerValueField(.keyboardEventKeycode))

    switch type {
    case .keyDown: isDown = true
    case .keyUp: isDown = false
    case .flagsChanged:
        // 修饰键（Fn/Shift/Cmd/Option/Ctrl）的状态变化只能通过 flagsChanged 观察。
        // 按事件携带的物理键码定位是哪一个修饰键变了，方向 = 对应 flags 位当前是否置位。
        // 旧实现把所有 flagsChanged 都当 Fn 上报：Shift 单独按下会被误报成 Fn 抬起，
        // 且 Fn+Shift 这类组合永远没有 Shift 事件，组合热键无法匹配。
        let rawKeyCode = Int64(event.getIntegerValueField(.keyboardEventKeycode))
        guard let mask = modifierMaskForKeyCode[rawKeyCode] else {
            return Unmanaged.passUnretained(event)  // CapsLock 等不关心
        }
        keyCode = Int32(rawKeyCode)
        let pressed = event.flags.contains(mask)
        if rawKeyCode == 0x3F { physicalFnPressed = pressed }
        // 修饰键列表要排除自己（组合键语义：主键按下时 modifiers 是"同时按住的其它键"）
        var mods = event.flags
        if pressed { mods.remove(mask) }
        let name = keyCodeToName[keyCode] ?? "Unknown"
        let payload: [String: Any] = [
            "type": pressed ? "keyDown" : "keyUp",
            "keyCode": Int(keyCode),
            "key": name,
            "modifiers": modifierName(mods),
            "isRepeat": false,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000)
        ]
        // koffi 会把 char* 拷贝成 JS 字符串，所以传栈上临时指针是安全的；
        // 用 withCString 而非 strdup 可避免泄漏（谁分配谁释放，这里不分配）。
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let json = String(data: data, encoding: .utf8) {
            name.withCString { namePtr in
                json.withCString { jsonPtr in
                    _ = cb(keyCode, namePtr, pressed ? 1 : 0, 0, jsonPtr)
                }
            }
        }
        return Unmanaged.passUnretained(event)
    default: return Unmanaged.passUnretained(event)
    }
    let flags = event.flags
    let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0

    // 纯修饰键按下不派发，避免热键判定时被修饰键本身污染。
    // 修饰键本身不派发，避免热键判定被污染；但 Fn 是合法的热键主键，
    // 已在上面单独处理，不会走到这里。
    let isModifierKey = [0x3B, 0x3A, 0x37, 0x38, 0x3C, 0x3E, 0x3D, 0x36].contains(keyCode)
    if isModifierKey { return Unmanaged.passUnretained(event) }

    let payload: [String: Any] = [
        "type": isDown ? "keyDown" : "keyUp",
        "keyCode": Int(keyCode),
        "key": keyCodeToName[keyCode] ?? "Unknown",
        "modifiers": modifierName(flags),
        "isRepeat": isRepeat,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ]

    // koffi 会拷贝 char* 为 JS 字符串，栈上临时指针安全。
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let json = String(data: data, encoding: .utf8) {
        let name = keyCodeToName[keyCode] ?? "Unknown"
        name.withCString { namePtr in
            json.withCString { jsonPtr in
                _ = cb(Int32(keyCode), namePtr, isDown ? 1 : 0, isRepeat ? 1 : 0, jsonPtr)
            }
        }
    }
    return Unmanaged.passUnretained(event)
}

/// 事件类型掩码。必须包含 flagsChanged，否则收不到 Fn 键事件。
private var eventMask: CGEventMask {
    (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
}

/// 创建并安装 event tap。
private func installTap() -> Bool {
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,          // 只监听不拦截，绝不能吞掉用户按键
        eventsOfInterest: eventMask,
        callback: tapCallback,
        userInfo: nil
    ) else { return false }

    gTap = tap
    gRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    // Koffi calls this synchronously on Electron's main thread. Retain the owner
    // so removal and retries always operate on the same running event loop.
    gRunLoop = CFRunLoopGetCurrent()
    CFRunLoopAddSource(gRunLoop, gRunLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

/// Remove only the tap, preserving the requested monitor and callback for recovery.
private func removeTap() {
    if let tap = gTap {
        CGEvent.tapEnable(tap: tap, enable: false)
        if let src = gRunLoopSource, let loop = gRunLoop {
            CFRunLoopRemoveSource(loop, src, .commonModes)
        }
        CFMachPortInvalidate(tap)
    }
    gTap = nil
    gRunLoopSource = nil
    gRunLoop = nil
    physicalFnPressed = false
}

private var gWatchdog: Timer?

private func recoverMonitor() {
    guard gMonitoringRequested, gCallback != nil else { return }
    if let tap = gTap, CGEvent.tapIsEnabled(tap: tap), CGPreflightListenEventAccess() { return }
    // Do not repeatedly prompt when permission is missing. Granting access later
    // is picked up automatically, including when the original installation failed.
    removeTap()
    guard CGPreflightListenEventAccess() else { return }
    if installTap() { gRecoveryCount += 1 }
}

private func startWatchdog() {
    gWatchdog?.invalidate()
    let timer = Timer(timeInterval: 2, repeats: true) { _ in recoverMonitor() }
    RunLoop.current.add(timer, forMode: .common)
    gWatchdog = timer
}

/// 0 = listening, -1 = input monitoring permission missing, -2 = wrong thread,
/// -3 = event tap creation/enable failed. Failure is retryable without relaunching.
@_cdecl("startKeyboardMonitor")
public func startKeyboardMonitor(_ callback: @escaping KeyCallback) -> Int32 {
    guard Thread.isMainThread else { return -2 }
    gCallback = callback
    gMonitoringRequested = true
    startWatchdog()
    guard CGPreflightListenEventAccess() else { removeTap(); return -1 }
    if let tap = gTap, CGEvent.tapIsEnabled(tap: tap) { return 0 }
    removeTap()
    guard installTap(), let tap = gTap, CGEvent.tapIsEnabled(tap: tap) else { return -3 }
    return 0
}

@_cdecl("stopKeyboardMonitor")
public func stopKeyboardMonitor() {
    gMonitoringRequested = false
    gWatchdog?.invalidate()
    gWatchdog = nil
    removeTap()
    gCallback = nil
}

/// Counts and timestamps only: never retain or expose arbitrary typed text.
@_cdecl("getKeyboardMonitorStatus")
public func getKeyboardMonitorStatus() -> UnsafeMutablePointer<CChar>? {
    let status: [String: Any] = [
        "inputMonitoring": CGPreflightListenEventAccess(),
        "requested": gMonitoringRequested,
        "active": gTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
        "callbackRegistered": gCallback != nil,
        "eventCount": gEventCount,
        "lastEventAt": gLastEventAt,
        "recoveryCount": gRecoveryCount
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: status),
          let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
}

#if KEYBOARD_TESTING
// Fault injection is compiled only into the test library. No synthetic event is
// posted to the OS; these calls exercise the real tap lifecycle and FFI callback.
@_cdecl("testDisableKeyboardTap")
public func testDisableKeyboardTap() {
    if let tap = gTap { CGEvent.tapEnable(tap: tap, enable: false) }
}
@_cdecl("testRecoverKeyboardTap")
public func testRecoverKeyboardTap() { recoverMonitor() }
@_cdecl("testDeliverKeyboardEvent")
public func testDeliverKeyboardEvent(_ code: Int32, _ type: Int32, _ flags: UInt64) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true), let eventType = CGEventType(rawValue: UInt32(type)) else { return }
    event.setIntegerValueField(.keyboardEventKeycode, value: Int64(code))
    event.flags = CGEventFlags(rawValue: flags)
    _ = tapCallback(OpaquePointer(bitPattern: 1)!, eventType, event, nil)
}
#endif

/// 列出所有键盘设备，用于多键盘场景下区分触发来源。
@_cdecl("getKeyboardDeviceList")
public func getKeyboardDeviceList() -> UnsafeMutablePointer<CChar>? {
    var devices: [[String: Any]] = []
    if let matching = IOServiceMatching("IOHIDDevice") {
        var iterator: io_iterator_t = 0
        if IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS {
            var service = IOIteratorNext(iterator)
            while service != 0 {
                defer { IOObjectRelease(service); service = IOIteratorNext(iterator) }
                func prop(_ key: String) -> String? {
                    IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?
                        .takeRetainedValue() as? String
                }
                if let usagePage = IORegistryEntryCreateCFProperty(service, "PrimaryUsagePage" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Int,
                   usagePage == 1 {
                    devices.append([
                        "name": prop("Product") ?? "Unknown",
                        "vendorId": prop("VendorID") ?? "",
                        "productId": prop("ProductID") ?? ""
                    ])
                }
            }
            IOObjectRelease(iterator)
        }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: devices),
          let str = String(data: data, encoding: .utf8) else { return strdup("[]") }
    return strdup(str)
}

/// 键名 -> 键码，热键配置持久化后需要反向还原。
@_cdecl("transformKeyNamesToKeyCodes")
public func transformKeyNamesToKeyCodes(_ namesPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let namesPtr else { return strdup("[]") }
    let names = String(cString: namesPtr).split(separator: ",").map(String.init)
    let codes = names.compactMap { name in keyCodeToName.first(where: { $0.value == name })?.key }.map(Int.init)
    guard let data = try? JSONSerialization.data(withJSONObject: codes),
          let str = String(data: data, encoding: .utf8) else { return strdup("[]") }
    return strdup(str)
}
