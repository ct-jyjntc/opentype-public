import { FormData } from 'undici'
import { serviceRequest } from '../network'
import { encodeWav } from '../pcm'
import { decodeLocalAudio } from '../local-asr/audio-decode'
import { audioSegments, joinTranscripts } from '../local-asr/segments'
import { LiveLocalTranscription } from '../local-asr/live-transcription'
import { refineTranscript, type RefinementConfig } from './refinement'
import type { SpeechProvider, TranscribeParams, TranscribeResult } from './types'

// This credential is scoped to this one official origin, never a configurable URL.
const ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions'
const MODEL = 'FunAudioLLM/SenseVoiceSmall'
const retryable = (detail: string) => ['siliconflow_network_error', 'siliconflow_timeout', 'siliconflow_unavailable'].includes(detail)
const supportedLanguage = (language: unknown) => ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(String(language ?? 'auto').split('-')[0].toLowerCase())
type SegmentResult = { text?: string; error?: string }

/** Short WAV requests while recording; only the assembled transcript is refined. */
export class SiliconFlowProvider implements SpeechProvider {
  readonly name = MODEL
  constructor(private readonly apiKey: string, private readonly refinement: RefinementConfig) {}

  private ready(language: unknown): string | undefined {
    if (!this.apiKey) return 'siliconflow_key_required'
    if (!supportedLanguage(language)) return 'unsupported_language'
  }

  private async transcribeSegment(audio: Uint8Array, signal?: AbortSignal): Promise<SegmentResult> {
    if (signal?.aborted) return { error: 'cancelled' }
    const timeout = AbortSignal.timeout(180_000)
    try {
      const form = new FormData()
      form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'speech.wav')
      form.append('model', MODEL)
      const response = await serviceRequest(ENDPOINT, {
        method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form,
        signal: AbortSignal.any([timeout, ...(signal ? [signal] : [])]),
      })
      if (response.statusCode !== 200) {
        // Never expose the upstream error body: it may echo request credentials.
        await response.body.dump()
        const status = response.statusCode
        return { error: status === 401 ? 'siliconflow_invalid_key'
          : status === 402 ? 'siliconflow_insufficient_balance'
          : status === 403 ? 'siliconflow_forbidden'
          : status === 429 ? 'siliconflow_rate_limited'
          : status === 400 || status === 413 || status === 422 ? 'siliconflow_audio_rejected'
          : status === 404 ? 'siliconflow_model_unavailable'
          : 'siliconflow_unavailable' }
      }
      // A 25-second segment cannot reasonably need a megabyte of response text.
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 1024 * 1024) {
          response.body.destroy()
          return { error: 'siliconflow_invalid_response' }
        }
        chunks.push(Buffer.from(chunk))
      }
      if (signal?.aborted) return { error: 'cancelled' }
      let payload: unknown
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return { error: 'siliconflow_invalid_response' } }
      if (!payload || typeof payload !== 'object' || typeof (payload as { text?: unknown }).text !== 'string')
        return { error: 'siliconflow_invalid_response' }
      // Empty segments can be silence; reject only an entirely empty recording.
      return { text: (payload as { text: string }).text.trim() }
    } catch (error) {
      return { error: signal?.aborted ? 'cancelled' : timeout.aborted ? 'siliconflow_timeout'
        : error instanceof Error && error.message === 'service_redirect_refused' ? 'siliconflow_redirect_refused'
        : 'siliconflow_network_error' }
    }
  }

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    const detail = this.ready(params.parameters?.language)
    if (detail) return { success: false, detail }
    params.onProgress?.({ stage: 'transcribing' })
    let wave: Awaited<ReturnType<typeof decodeLocalAudio>>
    try { wave = await decodeLocalAudio(params.audio) }
    catch { return { success: false, detail: params.signal?.aborted ? 'cancelled' : 'siliconflow_audio_rejected' } }
    const parts: string[] = []
    // History/retry paths are segmented too. There is no total recording cap;
    // each request stays far below the service's one-hour / 50 MB limit.
    for (const samples of audioSegments(wave.samples, wave.sampleRate)) {
      if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
      const result = await this.transcribeSegment(encodeWav([samples], wave.sampleRate), params.signal)
      if (result.error) return { success: false, detail: result.error }
      parts.push(result.text ?? '')
    }
    const rawText = joinTranscripts(parts)
    if (!rawText) return { success: false, detail: 'empty_transcription' }
    return refineTranscript(rawText, params, this.refinement)
  }

  startLiveTranscription(options: { language: string; signal: AbortSignal; onStableText?: (text: string, segments: number) => void }) {
    const detail = this.ready(options.language)
    if (detail) throw new Error(detail)
    let terminalError: string | undefined
    const live = new LiveLocalTranscription({ transcribe: async (audio, signal) => {
      if (terminalError) return { error: terminalError }
      const result = await this.transcribeSegment(audio, signal)
      // Authentication, quota and malformed requests must not be resubmitted for
      // every later pause. The recording remains intact for an explicit retry.
      if (result.error && !retryable(result.error)) terminalError = result.error
      return result
    } }, options.signal, options.onStableText, 'siliconflow_network_error', retryable)
    return {
      pushAudio: (samples: Float32Array) => live.pushAudio(samples),
      seal: () => live.seal(),
      finish: async (params: TranscribeParams): Promise<TranscribeResult> => {
        const signal = AbortSignal.any([options.signal, ...(params.signal ? [params.signal] : [])])
        const abort = () => live.dispose()
        signal.addEventListener('abort', abort, { once: true })
        try {
          if (signal.aborted) { live.dispose(); return { success: false, detail: 'cancelled' } }
          params.onProgress?.({ stage: 'transcribing' })
          const result = await live.finish()
          if (signal.aborted) return { success: false, detail: 'cancelled' }
          if (result.error) return { success: false, detail: result.error }
          if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
          return await refineTranscript(result.text, { ...params, signal }, this.refinement)
        } finally { signal.removeEventListener('abort', abort) }
      },
      dispose: () => live.dispose(),
    }
  }
}
