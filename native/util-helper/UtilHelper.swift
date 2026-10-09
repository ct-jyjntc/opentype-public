// 系统工具库：权限检查、麦克风设备枚举、静音控制、机器标识。

import Foundation
import AppKit
import AVFoundation
import ApplicationServices
import IOKit

@_cdecl("freeString")
public func freeString(_ ptr: UnsafeMutablePointer<CChar>?) {
    guard let ptr else { return }
    free(ptr)
}

/// 检查辅助功能权限。语音输入法没有这个权限就无法监听热键、无法注入文本。
/// 注意：kAXTrustedCheckOptionPrompt 必须传 true，否则系统不会弹出授权引导。
@_cdecl("checkAccessibilityPermission")
public func checkAccessibilityPermission() -> Int32 {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options) ? 1 : 0
}

/// 麦克风权限状态：0=未决定 1=受限 2=拒绝 3=已授权
@_cdecl("checkMicrophonePermission")
public func checkMicrophonePermission() -> Int32 {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .notDetermined: return 0
    case .restricted: return 1
    case .denied: return 2
    case .authorized: return 3
    @unknown default: return 0
    }
}

/// 枚举输入音频设备。直接走 CoreAudio，避免 AVFoundation 的设备类型 API 版本门槛
/// （AVCaptureDevice.DeviceType.microphone 需要 macOS 14+），同时能拿到真实的设备 UID 与传输类型。
@_cdecl("getAudioDevicesJSON")
public func getAudioDevicesJSON() -> UnsafeMutablePointer<CChar>? {
    var devices: [[String: Any]] = []
    var size = UInt32(0)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    ) == noErr else { return strdup("[]") }

    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids
    ) == noErr else { return strdup("[]") }

    let defaultID = defaultInputDeviceID()

    for (index, id) in ids.enumerated() {
        // 只保留有输入通道的设备，否则会列出扬声器、虚拟输出等无关项。
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamSize = UInt32(0)
        guard AudioObjectGetPropertyDataSize(id, &streamAddress, 0, nil, &streamSize) == noErr else { continue }
        let bufferList = UnsafeMutableRawPointer.allocate(
            byteCount: Int(streamSize), alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { bufferList.deallocate() }
        guard AudioObjectGetPropertyData(id, &streamAddress, 0, nil, &streamSize, bufferList) == noErr else { continue }
        let listPtr = bufferList.assumingMemoryBound(to: AudioBufferList.self)
        let buffers = UnsafeMutableAudioBufferListPointer(listPtr)
        let inputChannels = buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
        if inputChannels == 0 { continue }

        func deviceString(_ selector: AudioObjectPropertySelector) -> String {
            var addr = AudioObjectPropertyAddress(
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            // CoreAudio 返回 CFString 的所有权，用 Unmanaged 承接后再 takeRetainedValue，
            // 否则会形成 Optional<CFString> 的裸指针，ARC 下不安全。
            var cfStr: Unmanaged<CFString>?
            var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(id, &addr, 0, nil, &s, &cfStr) == noErr,
                  let result = cfStr?.takeRetainedValue() else { return "" }
            return result as String
        }

        let uid = deviceString(kAudioDevicePropertyDeviceUID)
        let name = deviceString(kAudioObjectPropertyName)
        devices.append([
            "deviceId": uid,
            "label": name,
            "groupId": deviceString(kAudioDevicePropertyModelUID),
            "channels": inputChannels,
            "index": index,
            "isDefault": defaultID == id
        ])
    }
    guard let data = try? JSONSerialization.data(withJSONObject: devices),
          let str = String(data: data, encoding: .utf8) else { return strdup("[]") }
    return strdup(str)
}

public typealias StringCallback = @convention(c) (UnsafePointer<CChar>?) -> Void

/// 异步版本：设备枚举在部分外设上会阻塞数百毫秒，放到后台队列避免卡住主进程。
@_cdecl("getAudioDevicesJSONAsync")
public func getAudioDevicesJSONAsync(_ callback: @escaping StringCallback) {
    DispatchQueue.global(qos: .userInitiated).async {
        let ptr = getAudioDevicesJSON()
        if let ptr {
            callback(UnsafePointer(ptr))
            free(ptr)
        } else {
            callback(nil)
        }
    }
}

/// 取默认输入设备的 CoreAudio 设备 ID。
/// AVFoundation 不暴露输入静音状态，必须走 CoreAudio 的 kAudioDevicePropertyMute。
private func defaultInputDeviceID() -> AudioDeviceID? {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID
    )
    return status == noErr && deviceID != 0 ? deviceID : nil
}

/// 读取输入设备静音状态：录音前若被静音，需要提示用户，否则录到的全是静音数据。
@_cdecl("isAudioMuted")
public func isAudioMuted() -> Int32 {
    guard let deviceID = defaultInputDeviceID() else { return -1 }
    var muted = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectHasProperty(deviceID, &address) else { return -1 }
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &muted)
    return status == noErr ? Int32(muted) : -1
}

private func setInputMute(_ muted: UInt32) -> Int32 {
    guard let deviceID = defaultInputDeviceID() else { return -1 }
    var value = muted
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectHasProperty(deviceID, &address) else { return -1 }
    let status = AudioObjectSetPropertyData(
        deviceID, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value
    )
    return status == noErr ? 0 : -1
}

@_cdecl("muteAudio")
public func muteAudio() -> Int32 { setInputMute(1) }

@_cdecl("unmuteAudio")
public func unmuteAudio() -> Int32 { setInputMute(0) }

/// 合盖状态：合盖时麦克风不可用，用于提前拦截录音。
@_cdecl("deviceIsLidOpen")
public func deviceIsLidOpen() -> Int32 {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard service != 0 else { return 1 }
    defer { IOObjectRelease(service) }
    if let value = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool {
        return value ? 0 : 1   // 合盖为 true，返回 0
    }
    return 1
}

/// 稳定的匿名设备标识，用于按设备维度做配额与去重。取硬件 UUID，不涉及用户身份。
@_cdecl("getDeviceId")
public func getDeviceId() -> UnsafeMutablePointer<CChar>? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { return strdup("unknown") }
    defer { IOObjectRelease(service) }
    if let uuid = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String {
        return strdup(uuid)
    }
    return strdup("unknown")
}

/// 按名称或 bundle id 启动应用，用于「识别到目标应用未启动时自动拉起」。
@_cdecl("launchApplicationByName")
public func launchApplicationByName(_ namePtr: UnsafePointer<CChar>?) -> Bool {
    guard let namePtr else { return false }
    let name = String(cString: namePtr)
    let workspace = NSWorkspace.shared

    // 先按 bundle id 找，找不到再按 /Applications 下的应用名找。
    let url = workspace.urlForApplication(withBundleIdentifier: name)
        ?? workspace.urlForApplication(toOpen: URL(fileURLWithPath: "/Applications/\(name).app"))
    guard let appURL = url else { return false }
    return workspace.open(appURL)
}
