import type { HistoryRow } from '../db'
import type { SpeechProvider, TranscribeResult } from './providers/types'
import type { LocalMode } from './protocol'
import { jsonObject, voiceContext } from './voice-context'
import { applyOutputPreferences } from './output-format'

export interface RendererVoiceOptions {
  getProvider: () => SpeechProvider
  loadHistory?: (audioId: string) => Promise<HistoryRow | null>
  personalization?: (record: HistoryRow | null | undefined) => Promise<Record<string, unknown>>
  getConfig: () => { asrLanguage?: string; outputLanguage?: string; blacklistDomains: string[] }
}

const modes = new Set<LocalMode>(['voice_transcript', 'voice_translation', 'voice_command'])

/** The UI's request lifecycle is independent of the legacy PCM recording state machine. */
export class RendererVoiceService {
  private requests = new Map<string, AbortController>()
  private audioRequests = new Map<AbortController, string>()

  constructor(private readonly options: RendererVoiceOptions) {}

  cancel(abortId: string): void { this.requests.get(abortId)?.abort() }

  cancelAudio(audioId: string): void {
    for (const [controller, id] of this.audioRequests) if (id === audioId) controller.abort()
  }

  dispose(): void {
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    this.audioRequests.clear()
  }

  async run(params: Record<string, unknown>) {
    const audioId = String(params.audioId ?? '')
    const abortId = String(params.abortId ?? audioId)
    const controller = new AbortController()
    this.cancel(abortId)
    this.requests.set(abortId, controller)
    this.audioRequests.set(controller, audioId)
    let result: TranscribeResult
    try {
      if (!audioId) throw new Error('audio_id_required')
      const record = await this.options.loadHistory?.(audioId)
      controller.signal.throwIfAborted()
      const mode = (record?.mode ?? params.mode ?? 'voice_transcript') as LocalMode
      if (!modes.has(mode)) throw new Error('invalid_mode')
      const buffer = params.arrayBuffer
      const audio = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
        : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null
      if (!audio?.byteLength) throw new Error('empty_audio')
      const config = this.options.getConfig()
      const meta = jsonObject(record?.modeMeta)
      const audioMetadata = jsonObject(record?.audioMetadata)
      const duration = Number(record?.duration ?? params.duration ?? 0)
      audioMetadata.audio_duration = duration
      const audioContext = voiceContext(record?.audioContext, record ?? {}, config.blacklistDomains)
      const parameters: Record<string, unknown> = {}
      if (mode === 'voice_command' && typeof meta.selected_text === 'string' && !audioContext.redacted) {
        parameters.selected_text = meta.selected_text
      }
      if (mode === 'voice_translation') {
        const language = params.outputLanguage || meta.output_language || config.outputLanguage
        if (typeof language !== 'string' || !language.trim()) throw new Error('output_language_required')
        parameters.output_language = language
      }
      if (config.asrLanguage) parameters.language = config.asrLanguage
      const provider = this.options.getProvider()
      Object.assign(parameters, await this.options.personalization?.(record))
      controller.signal.throwIfAborted()
      const request = {
        mode, audio, audioId, duration, audioMetadata, audioContext, parameters,
        deviceName: typeof params.deviceName === 'string' ? params.deviceName : undefined,
        isRetry: Boolean(params.isRetry), signal: controller.signal
      }
      result = applyOutputPreferences(await provider.transcribe(request), request)
      controller.signal.throwIfAborted()
    } catch (err) {
      result = { success: false, detail: controller.signal.aborted ? 'cancelled' : (err as Error).message }
    } finally {
      if (this.requests.get(abortId) === controller) this.requests.delete(abortId)
      this.audioRequests.delete(controller)
    }
    return {
      refine_text: result.text ?? '', raw_text: result.rawText ?? result.text ?? '',
      delivery: result.delivery, user_prompt: result.userPrompt,
      web_metadata: result.webMetadata, external_action: result.externalAction,
      success: result.success, aborted: controller.signal.aborted,
      detail: result.detail, code: result.code, paywall: result.paywall, debug: null
    }
  }
}
