import Foundation
import Speech
import AVFoundation

struct SpeechFailure: Error { let code: String }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func resolvedLocale(_ language: String) -> Locale {
    Locale(identifier: language == "auto" ? Locale.current.identifier : language)
}

@available(macOS 26.0, *)
func modernLocale(_ locale: Locale) async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    return await SpeechTranscriber.supportedLocale(equivalentTo: locale)
}

func status(_ locale: Locale) async -> [String: Any] {
    if #available(macOS 26.0, *), let supported = await modernLocale(locale) {
        let module = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        let installed = await AssetInventory.status(forModules: [module]) == .installed
        return ["available": true, "engine": "SpeechAnalyzer", "locale": supported.identifier,
                "installed": installed, "supportedLocales": await SpeechTranscriber.supportedLocales.map { $0.identifier }]
    }
    let recognizer = SFSpeechRecognizer(locale: locale)
    let offline = recognizer?.supportsOnDeviceRecognition == true
    let permission = SFSpeechRecognizer.authorizationStatus()
    return ["available": offline, "engine": "SFSpeechRecognizer", "locale": locale.identifier,
            "installed": offline && permission == .authorized,
            "permission": permission.rawValue,
            "supportedLocales": SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted(),
            "error": !offline ? "apple_speech_offline_unavailable" : permission == .denied || permission == .restricted ? "apple_speech_permission" : ""]
}

func prepare(_ locale: Locale) async throws {
    if #available(macOS 26.0, *), let supported = await modernLocale(locale) {
        let module = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        try await AssetInventory.reserve(locale: supported)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await request.downloadAndInstall()
        }
        return
    }
    guard SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true else {
        throw SpeechFailure(code: "apple_speech_offline_unavailable")
    }
    let permission = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard permission == .authorized else { throw SpeechFailure(code: "apple_speech_permission") }
}

@available(macOS 26.0, *)
func modernTranscribe(_ path: String, _ locale: Locale) async throws -> String {
    let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    guard await AssetInventory.status(forModules: [module]) == .installed else {
        throw SpeechFailure(code: "apple_speech_model_missing")
    }
    let analyzer = SpeechAnalyzer(modules: [module])
    let results = Task { () throws -> String in
        var text = ""
        for try await result in module.results { text += String(result.text.characters) }
        return text
    }
    do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else { await analyzer.cancelAndFinishNow() }
        return try await results.value
    } catch {
        results.cancel()
        await analyzer.cancelAndFinishNow()
        throw error
    }
}

// Keep the recognizer/task alive until a final result, and resume the continuation once.
// SFSpeechRecognizer's callbacks run on its queue (the main queue by default).
@MainActor
final class LegacyJob {
    var recognizer: SFSpeechRecognizer?
    var task: SFSpeechRecognitionTask?
    var continuation: CheckedContinuation<String, Error>?
    func run(_ path: String, _ locale: Locale) async throws -> String {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else { throw SpeechFailure(code: "apple_speech_permission") }
        recognizer = SFSpeechRecognizer(locale: locale)
        guard recognizer?.supportsOnDeviceRecognition == true else { throw SpeechFailure(code: "apple_speech_offline_unavailable") }
        guard recognizer?.isAvailable == true else { throw SpeechFailure(code: "apple_speech_unavailable") }
        let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            task = recognizer?.recognitionTask(with: request) { result, error in
                Task { @MainActor in
                    if let result, result.isFinal { self.finish(.success(result.bestTranscription.formattedString)) }
                    else if error != nil { self.finish(.failure(SpeechFailure(code: "apple_speech_failed"))) }
                }
            }
        }
    }
    func finish(_ result: Result<String, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
        task = nil
        recognizer = nil
    }
}

@main
struct AppleSpeech {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3 else { emit(["error": "invalid_config"]); return }
        let locale = resolvedLocale(args[2])
        do {
            switch args[1] {
            case "status": emit(await status(locale))
            case "install":
                try await prepare(locale)
                emit(await status(locale))
            case "transcribe":
                guard args.count == 4 else { throw SpeechFailure(code: "invalid_audio") }
                let text: String
                if #available(macOS 26.0, *), let supported = await modernLocale(locale) {
                    text = try await modernTranscribe(args[3], supported)
                } else { text = try await LegacyJob().run(args[3], locale) }
                emit(["text": text])
            default: throw SpeechFailure(code: "invalid_config")
            }
        } catch let error as SpeechFailure { emit(["error": error.code]) }
        catch { emit(["error": args[1] == "install" ? "apple_speech_install_failed" : "apple_speech_failed"]) }
    }
}
