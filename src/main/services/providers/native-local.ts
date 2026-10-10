import type { SpeechProvider, TranscribeParams, TranscribeResult } from './types'
import type { LocalAsrProcess } from '../local-asr/process'
import { refineTranscript, type RefinementConfig } from './refinement'
import { LiveLocalTranscription } from '../local-asr/live-transcription'

/** Our codes (zh-CN, yue, en, …) → SenseVoice ids (zh, yue, en, ja, ko, auto). */
function senseVoiceLanguage(language: unknown) {
  return String(language || 'auto').split('-')[0].toLowerCase()
}
function supportedLanguage(language: unknown) {
  return ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(senseVoiceLanguage(language))
}

export class NativeLocalProvider implements SpeechProvider {
  readonly name = 'sensevoice-small-int8'
  constructor(private readonly engine: Pick<LocalAsrProcess, 'transcribe'>,
    private readonly refinement: RefinementConfig) {}

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    if (!supportedLanguage(params.parameters?.language)) return { success: false, detail: 'unsupported_language' }
    params.onProgress?.({ stage: 'transcribing' })
    const result = await this.engine.transcribe(params.audio, params.signal, senseVoiceLanguage(params.parameters?.language))
    if (params.signal?.aborted || result.error === 'cancelled') return { success: false, detail: 'cancelled' }
    if (result.error) return { success: false, detail: result.error }
    if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
    return refineTranscript(result.text, params, this.refinement)
  }

  startLiveTranscription(options: { language: string; signal: AbortSignal; onStableText?: (text: string, segments: number) => void }) {
    // Fail at start like SiliconFlow, not after the user has dictated for minutes.
    if (!supportedLanguage(options.language)) throw new Error('unsupported_language')
    // Every pause segment is decoded with the language chosen at start.
    const language = senseVoiceLanguage(options.language)
    const live = new LiveLocalTranscription({ transcribe: (audio, signal) => this.engine.transcribe(audio, signal, language) },
      options.signal, options.onStableText)
    return {
      pushAudio: (samples: Float32Array) => live.pushAudio(samples),
      seal: () => live.seal(),
      finish: async (params: TranscribeParams): Promise<TranscribeResult> => {
        params.onProgress?.({ stage: 'transcribing' })
        const result = await live.finish()
        if (options.signal.aborted) return { success: false, detail: 'cancelled' }
        if (result.error) return { success: false, detail: result.error }
        if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
        return refineTranscript(result.text, params, this.refinement)
      },
      dispose: () => live.dispose(),
    }
  }
}
