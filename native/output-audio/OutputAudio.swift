// A separate lease process restores output settings when its parent closes stdin,
// including parent crashes. Only properties still equal to our applied value are restored.
import Foundation
import CoreAudio
import Darwin

struct OutputEntry: Codable {
    let uid: String
    let element: UInt32
    let mute: Bool
    let previous: Float32
    let applied: Float32
}

final class OutputLease {
    let journal: URL
    let mode: String
    var entries: [OutputEntry] = []
    var ignored = Set<String>()
    var lastNotice = ""
    var stopping = false
    init(journal: URL, mode: String) {
        self.journal = journal; self.mode = mode
        if let data = try? Data(contentsOf: journal), data.count <= 128_000,
           let saved = try? JSONDecoder().decode([OutputEntry].self, from: data), saved.count <= 256 {
            entries = saved.filter { $0.previous.isFinite && $0.applied.isFinite && $0.previous >= 0 && $0.previous <= 1 && $0.applied >= 0 && $0.applied <= 1 }
        }
    }
    func notice(_ value: String) {
        if value == lastNotice { return }; lastNotice = value
        if let data = ("{\"notice\":\"" + value + "\"}\n").data(using: .utf8) { try? FileHandle.standardOutput.write(contentsOf: data) }
    }
    func persist() -> Bool {
        do {
            let data = try JSONEncoder().encode(entries)
            try data.write(to: journal, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journal.path)
            let handle = try FileHandle(forWritingTo: journal); try handle.synchronize(); try handle.close()
            return true
        } catch { notice("output_audio_unavailable"); return false }
    }
    func devices() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }
    func uid(_ id: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?, size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let string = value?.takeRetainedValue() else { return nil }
        return string as String
    }
    func defaultOutput() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr, device != 0 else { return nil }
        return device
    }
    func address(_ entry: OutputEntry) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: entry.mute ? kAudioDevicePropertyMute : kAudioDevicePropertyVolumeScalar,
            mScope: kAudioDevicePropertyScopeOutput, mElement: entry.element)
    }
    func read(_ id: AudioDeviceID, _ entry: OutputEntry) -> Float32? {
        var addr = address(entry), size: UInt32 = 4
        if entry.mute {
            var value: UInt32 = 0
            return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? Float32(value) : nil
        }
        var value: Float32 = 0
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr && value.isFinite ? value : nil
    }
    func writable(_ id: AudioDeviceID, _ entry: OutputEntry) -> Bool {
        var addr = address(entry), settable = DarwinBoolean(false)
        return AudioObjectHasProperty(id, &addr) && AudioObjectIsPropertySettable(id, &addr, &settable) == noErr && settable.boolValue
    }
    func write(_ id: AudioDeviceID, _ entry: OutputEntry, _ value: Float32) -> Bool {
        var addr = address(entry)
        if entry.mute {
            var value = UInt32(value.rounded())
            return AudioObjectSetPropertyData(id, &addr, 0, nil, 4, &value) == noErr
        }
        var value = value
        return AudioObjectSetPropertyData(id, &addr, 0, nil, 4, &value) == noErr
    }
    func restore(except keep: String? = nil) {
        let ids = devices()
        var pending: [OutputEntry] = []
        for entry in entries {
            if entry.uid == keep { pending.append(entry); continue }
            guard let id = ids.first(where: { uid($0) == entry.uid }), let current = read(id, entry) else { pending.append(entry); continue }
            // Different current value means the user or another application owns it now.
            if abs(current - entry.applied) > 0.0005 { continue }
            if !write(id, entry, entry.previous) { pending.append(entry) }
        }
        if pending.count != entries.count { entries = pending; _ = persist() }
        if entries.isEmpty { try? FileManager.default.removeItem(at: journal) }
    }
    func tick() {
        guard !stopping else { return }
        guard let device = defaultOutput(), let deviceUID = uid(device) else { restore(); notice("output_audio_unavailable"); return }
        restore(except: deviceUID)
        let owned = entries.filter { $0.uid == deviceUID }
        if !owned.isEmpty {
            if owned.contains(where: { entry in guard let value = read(device, entry) else { return false }; return abs(value - entry.applied) > 0.0005 }) {
                ignored.insert(deviceUID); restore(); notice("output_audio_changed")
            }
            return
        }
        if ignored.contains(deviceUID) { return }
        func candidate(_ element: UInt32, _ mute: Bool) -> OutputEntry? {
            let query = OutputEntry(uid: deviceUID, element: element, mute: mute, previous: 0, applied: 0)
            guard writable(device, query), let current = read(device, query), current >= 0, current <= 1 else { return nil }
            let next: Float32 = mute ? 1 : mode == "duck" ? current * 0.2 : 0
            return OutputEntry(uid: deviceUID, element: element, mute: mute, previous: current, applied: next)
        }
        var changes: [OutputEntry] = []
        if mode == "mute", let master = candidate(0, true) { changes = [master] }
        else if let master = candidate(0, false) { changes = [master] }
        else { changes = (1...64).compactMap { candidate(UInt32($0), false) } }
        // Already silent devices are left alone for the whole recording.
        let active = changes.filter { abs($0.previous - $0.applied) > 0.0005 }
        if active.isEmpty { ignored.insert(deviceUID); if changes.isEmpty { notice("output_audio_unavailable") }; return }
        let old = entries
        entries += active
        guard persist() else { entries = old; ignored.insert(deviceUID); return }
        var applied = false
        for entry in active { if write(device, entry, entry.applied) { applied = true } }
        if !applied { restore(); ignored.insert(deviceUID); notice("output_audio_unavailable") }
        else { notice("") }
    }
    func stop() -> Never {
        stopping = true; restore()
        if !entries.isEmpty { notice("output_audio_restore_pending") }
        exit(0)
    }
}

guard CommandLine.arguments.count == 3, ["duck", "mute", "recover"].contains(CommandLine.arguments[1]),
      CommandLine.arguments[2].hasPrefix("/") else { exit(2) }
// Serialize output control across all OpenType profiles for this OS user.
let lockPath = FileManager.default.temporaryDirectory.appendingPathComponent("OpenType-output-control.lock").path
let lockFD = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { exit(3) }
signal(SIGPIPE, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let lease = OutputLease(journal: URL(fileURLWithPath: CommandLine.arguments[2]), mode: CommandLine.arguments[1])
lease.restore()
if lease.mode == "recover" { lease.stop() }
lease.tick()
// Already-silent devices still completed startup.
let startupNotice = lease.lastNotice
lease.lastNotice = "initial"
lease.notice(startupNotice)
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + .milliseconds(300), repeating: .milliseconds(300))
timer.setEventHandler { lease.tick() }; timer.resume()
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { lease.stop() }; terminate.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { lease.stop() }; interrupt.resume()
DispatchQueue.global(qos: .utility).async {
    // No application data is sent here. EOF is the lease release signal.
    _ = FileHandle.standardInput.readDataToEndOfFile()
    DispatchQueue.main.async { lease.stop() }
}
dispatchMain()
