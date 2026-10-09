import type { SpeechProvider, TranscribeParams, TranscribeResult } from './types'
import type { LocalAsrProcess } from '../local-asr/process'
import { refineTranscript, type RefinementConfig } from './refinement'
import { LiveLocalTranscription } from '../local-asr/live-transcription'

function supportedLanguage(language: unknown) {
  const lang = String(language ?? 'auto').split('-')[0].toLowerCase()
  return ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(lang)
}

export class NativeLocalProvider implements SpeechProvider {
  readonly name = 'sensevoice-small-int8'
  constructor(private readonly engine: Pick<LocalAsrProcess, 'transcribe'>,
    private readonly refinement: RefinementConfig) {}

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    if (!supportedLanguage(params.parameters?.language)) return { success: false, detail: 'unsupported_language' }
    params.onProgress?.({ stage: 'transcribing' })
    const result = await this.engine.transcribe(params.audio, params.signal)
    if (params.signal?.aborted || result.error === 'cancelled') return { success: false, detail: 'cancelled' }
    if (result.error) return { success: false, detail: result.error }
    if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
    return refineTranscript(result.text, params, this.refinement)
  }

  startLiveTranscription(options: { language: string; signal: AbortSignal; onStableText?: (text: string, segments: number) => void }) {
    if (!supportedLanguage(options.language)) return undefined
    const live = new LiveLocalTranscription(this.engine, options.signal, options.onStableText)
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
