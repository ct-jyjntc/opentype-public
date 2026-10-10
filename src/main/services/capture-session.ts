import { appliedSkill } from '../../shared/skills'
import { jsonObject, voiceContext } from './voice-context'
import { randomUUID } from 'node:crypto'
import { encodeWav } from './pcm'
import { RendererVoiceService } from './renderer-voice'
import { applyOutputPreferences } from './output-format'
import type { DeliveryOutcome } from './input-delivery'
import type { LiveTranscription, SpeechProvider, TranscribeParams, TranscribeResult } from './providers/types'
import type { HistoryInsert, HistoryRow } from '../db'
import type { CaptureMode, VoiceState } from '../../shared/desktop'
export interface CaptureSettings {
  mode: CaptureMode
  outputLanguage: string
  asrLanguage: string
  autoInject: boolean
  blacklistDomains: string[]
  appVersion: string
}
export interface CaptureTarget {
  inputTraceId?: string
  inputToken?: string
  inputError?: string
  inputWebDomains?: string[]
  appName: string
  bundleId: string
  audioContext: Record<string, unknown>
  selectedText: string
}
export interface PersonalizationTarget {
  appName: string
  bundleId: string
  mode?: CaptureMode
  audioContext?: Record<string, unknown>
  skillId?: string | null
}
interface Session {
  id: string
  started: number
  controller: AbortController
  chunks: Float32Array[]
  sampleRate: number
  samples: number
  stopping: boolean
  acceptingAudio: boolean
  provider: SpeechProvider
  live?: LiveTranscription
  settings: CaptureSettings
  target: CaptureTarget
  targetTransferred?: boolean
  skillName?: string
  captureWarning?: string
  preview?: string
  completedSegments?: number
  personalization?: Promise<Record<string, unknown>>
}
export interface CaptureSessionDeps {
  provider: SpeechProvider
  getConfig: () => CaptureSettings
  context: (mode: CaptureMode, signal: AbortSignal, preview?: boolean, traceId?: string) => CaptureTarget | Promise<CaptureTarget>
  notify: (state: VoiceState) => void
  flush: (id: string) => Promise<void>
  saveAudio: (id: string, data: Uint8Array) => Promise<string>
  saveHistory: (record: HistoryInsert) => Promise<void>
  loadHistory: (id: string) => Promise<HistoryRow | null>
  inject: (
    text: string,
    target: CaptureTarget,
    signal: AbortSignal,
  ) => Promise<DeliveryOutcome | void>
  releaseTarget?: (target: CaptureTarget) => void
  observeInput?: (id: string, text: string, target: CaptureTarget) => boolean
  showFallback?: (text: string, id: string) => void
  showCard: (text: string, id: string, target: CaptureTarget) => boolean | void
  changed: () => void
  personalization: (target: PersonalizationTarget) => Promise<Record<string, unknown>>
}
/** One renderer owns the microphone. Stop waits for its worklet acknowledgement before encoding. */
export class CaptureSession {
  private session: Session | null = null
  private starting: { id: string; controller: AbortController } | null = null
  private provider: SpeechProvider
  private rendererVoice: RendererVoiceService
  private mode: CaptureMode | undefined
  constructor(private deps: CaptureSessionDeps) {
    this.provider = deps.provider
    this.rendererVoice = new RendererVoiceService({
      getProvider: () => this.provider,
      personalization: record => deps.personalization({
        appName: record?.focusedAppName ?? '', bundleId: record?.focusedAppBundleId ?? '',
        mode: record?.mode, audioContext: voiceContext(record?.audioContext, record ?? {}, deps.getConfig().blacklistDomains),
        skillId: typeof jsonObject(record?.modeMeta).skill_id === 'string' ? String(jsonObject(record?.modeMeta).skill_id) : null,
      }),
      loadHistory: deps.loadHistory,
      getConfig: deps.getConfig,
    })
  }
  private notify(state: VoiceState) {
    this.deps.notify(this.mode && state.phase !== 'idle' ? { ...state, mode: this.mode } : state)
  }
  get isBusy() {
    return !!this.starting || !!this.session
  }
  get isRecording() {
    // A release/second press during the handoff cancels startup, never queues
    // microphone capture after the user has already released the shortcut.
    return !!this.starting || (!!this.session && !this.session.stopping)
  }
  setProvider(provider: SpeechProvider) {
    this.provider = provider
  }
  voiceFlowForRenderer(params: Record<string, unknown>) {
    return this.rendererVoice.run(params)
  }
  cancelByAbortId(id: string) {
    this.rendererVoice.cancel(id)
    this.rendererVoice.cancelAudio(id)
    if (this.session?.id === id || this.starting?.id === id) this.onCancel()
  }
  async onStart(options: { preview?: boolean } = {}) {
    if (this.isBusy) return null
    const id = randomUUID()
    const pending = { id, controller: new AbortController() }
    const provider = this.provider
    this.starting = pending
    let target: CaptureTarget | undefined
    let current: Session | undefined
    try {
      const settings = { ...this.deps.getConfig(),
        ...(options.preview ? { autoInject: false, mode: 'voice_transcript' as const } : {}) }
      this.mode = settings.mode
      this.notify({ phase: 'preparing', audioId: id })
      target = await this.deps.context(settings.mode, pending.controller.signal, options.preview, id)
      if (this.starting !== pending || pending.controller.signal.aborted) {
        this.deps.releaseTarget?.(target)
        return null
      }
      current = this.session = {
        id,
        started: Date.now(),
        controller: pending.controller,
        chunks: [],
        sampleRate: 16000,
        samples: 0,
        stopping: false,
        acceptingAudio: true,
        provider,
        settings,
        target,
      }
      this.starting = null
      const active = current
      this.session.personalization = this.deps.personalization({ ...this.session.target, mode: settings.mode })
      // Observe rejection now; onStop still reports the original error. A cancelled
      // capture must not leave an unhandled dictionary-read rejection behind.
      void current.personalization!.then(value => {
        active.skillName = appliedSkill(value.skill)?.name
        if (this.session === active && !active.stopping) this.notify({ phase: 'recording', audioId: id, skillName: active.skillName, preview: active.preview, completedSegments: active.completedSegments })
      }).catch(() => {})
      this.session.live = this.session.provider.startLiveTranscription?.({
        language: this.session.settings.asrLanguage,
        signal: this.session.controller.signal,
        onStableText: (preview, completedSegments) => {
          if (this.session !== active || active.controller.signal.aborted) return
          active.preview = preview; active.completedSegments = completedSegments
          if (!active.stopping) this.notify({ phase: 'recording', audioId: id, preview, completedSegments, skillName: active.skillName })
        },
      })
      this.notify({ phase: 'recording', audioId: id })
      return { audioId: id }
    } catch (error) {
      const ownsStartup = this.starting === pending || (current !== undefined && this.session === current)
      pending.controller.abort()
      current?.live?.dispose()
      if (target) this.deps.releaseTarget?.(target)
      if (this.starting === pending) this.starting = null
      if (current && this.session === current) this.session = null
      if (ownsStartup) this.notify({ phase: 'error', audioId: id, detail: (error as Error).message || 'capture_failed' })
      return null
    }
  }
  pushAudio(pcm: Float32Array, sampleRate: number, _level: number, audioId?: string) {
    const s = this.session
    if (
      !s ||
      !s.acceptingAudio ||
      (audioId !== undefined && audioId !== s.id) ||
      s.controller.signal.aborted ||
      sampleRate !== 16000 ||
      !pcm.length
    )
      return
    s.chunks.push(pcm)
    s.samples += pcm.length
    s.sampleRate = sampleRate
    s.live?.pushAudio(pcm)
  }
  pushLevel(level: number) {
    const s = this.session
    if (s && !s.stopping)
      this.notify({ phase: 'recording', audioId: s.id, level, skillName: s.skillName, preview: s.preview, completedSegments: s.completedSegments })
  }
  captureFailed(id: string, detail = 'capture_failed') {
    const current = this.session
    if (current?.id !== id) return
    if (detail === 'microphone_disconnected') {
      current.captureWarning = 'microphone_disconnected_saved'
      void this.onStop()
      return
    }
    this.onCancel()
    this.notify({ phase: 'error', audioId: id, detail })
  }
  async onStop(): Promise<TranscribeResult | null> {
    if (this.starting) { this.onCancel(); return null }
    const s = this.session
    if (!s || s.stopping) return null
    s.stopping = true
    const provider = s.provider,
      signal = s.controller.signal
    let saved = false,
      duration = 0
    let row: HistoryInsert | undefined
    const notify = (
      phase: VoiceState['phase'],
      detail?: string,
      text?: string,
    ) => {
      if (this.session === s)
        this.notify({ phase, audioId: s.id, detail, text, skillName: s.skillName })
    }
    try {
      notify('stopping')
      try { await this.deps.flush(s.id) } catch (error) {
        // A disconnected device may never acknowledge its worklet tail. Preserve
        // every chunk already received instead of dropping the entire recording.
        if (!s.captureWarning) throw error
      }
      s.acceptingAudio = false
      signal.throwIfAborted()
      // Seal the ASR tail immediately after the microphone ACK. Encoding, disk I/O,
      // and personalization can then overlap the remaining native inference.
      s.live?.seal()
      duration = s.samples / s.sampleRate
      if (s.samples === 0) {
        notify(s.captureWarning ? 'error' : 'cancelled', s.captureWarning ? 'microphone_disconnected' : 'empty_audio')
        return null
      }
      notify('encoding')
      const data = encodeWav(s.chunks, s.sampleRate)
      const audioPath = await this.deps.saveAudio(s.id, data)
      const meta: Record<string, unknown> = {
        skill_id: null,
        capture_warning: s.captureWarning,
        selected_text: s.target.selectedText,
        output_language: s.settings.outputLanguage,
      }
      row = {
        id: s.id,
        mode: s.settings.mode,
        status: 'transcribing',
        duration,
        audioLocalPath: audioPath,
        audioMetadata: JSON.stringify({
          audio_format: 'wav',
          sample_rate: s.sampleRate,
          audio_duration: duration,
        }),
        audioContext: JSON.stringify(s.target.audioContext),
        modeMeta: JSON.stringify(meta),
        focusedAppName: s.target.appName,
        focusedAppBundleId: s.target.bundleId,
        createdAt: new Date(s.started).toISOString(),
        updatedAt: new Date().toISOString(),
        appVersion: s.settings.appVersion,
      }
      await this.deps.saveHistory(row)
      saved = true
      signal.throwIfAborted()
      notify('uploading')
      const params: TranscribeParams = {
        mode: s.settings.mode,
        audio: data,
        audioId: s.id,
        duration,
        audioMetadata: { audio_duration: duration, audio_format: 'wav' },
        audioContext: s.target.audioContext,
        parameters: {
          language: s.settings.asrLanguage,
          output_language: s.settings.outputLanguage,
          selected_text: s.target.selectedText,
          ...(await s.personalization),
        },
        isRetry: false,
        signal,
        onProgress: progress => {
          if (this.session !== s || signal.aborted) return
          this.notify({ phase: progress.stage, audioId: s.id, skillName: s.skillName,
            preview: progress.stage === 'transcribing' ? s.preview : progress.preview?.slice(-600), completedSegments: s.completedSegments })
        },
      }
      signal.throwIfAborted()
      const selectedSkill = appliedSkill(params.parameters?.skill)
      if (selectedSkill) { meta.skill_id = selectedSkill.id; meta.skill_name = selectedSkill.name; meta.skill_source = selectedSkill.source }
      const result = applyOutputPreferences(await (s.live ? s.live.finish(params) : provider.transcribe(params)), params)
      signal.throwIfAborted()
      if (s.captureWarning && result.success && !result.detail) result.detail = s.captureWarning
      // Questions and edit requests both show their answer first. Only an
      // explicit card action may replace a captured editable selection.
      if (result.success && s.settings.mode === 'voice_command' && result.delivery !== 'external') result.delivery = 'card'
      const final = {
        ...row,
        status: result.success ? ('completed' as const) : ('failed' as const),
        refinedText: result.text ?? null,
        modeMeta: JSON.stringify({
          ...meta,
          raw_text: result.rawText ?? '',
          delivery: result.delivery,
        }),
        debugInfo: JSON.stringify({ detail: result.detail }),
        syncStatus: result.success
          ? ('pending_upload' as const)
          : ('sync_failed' as const),
        updatedAt: new Date().toISOString(),
      }
      await this.deps.saveHistory(final)
      signal.throwIfAborted()
      if (result.success && result.text) {
        if (
          s.settings.mode === 'voice_command' &&
          result.delivery !== 'external'
        )
          s.targetTransferred = this.deps.showCard(result.text, s.id, s.target) === true
        else if (s.settings.autoInject && result.delivery !== 'external') {
          notify('injecting', undefined, result.text)
          let delivered: DeliveryOutcome | void
          try {
            delivered = await this.deps.inject(result.text, s.target, signal)
          } catch (error) {
            signal.throwIfAborted()
            result.detail = (error as Error).message || 'injection_failed'
            result.delivery = 'manual'
            await this.deps.saveHistory({ id: s.id, status: 'completed',
              modeMeta: JSON.stringify({ ...meta, raw_text: result.rawText ?? '', delivery: 'manual', input_delivery: 'failed' }),
              debugInfo: JSON.stringify({ detail: result.detail }), updatedAt: new Date().toISOString() })
            signal.throwIfAborted()
            this.deps.showFallback?.(result.text, s.id)
            notify('error', result.detail, result.text)
            return result
          }
          // A submitted write cannot be unsent by cancelling its verification.
          if (!delivered) signal.throwIfAborted()
          if (delivered) {
            result.detail = delivered.detail ?? result.detail
            try {
              await this.deps.saveHistory({ id: s.id, status: 'completed',
                modeMeta: JSON.stringify({ ...meta, raw_text: result.rawText ?? '', delivery: result.delivery,
                  input_delivery: delivered.status, input_method: delivered.method }),
                debugInfo: JSON.stringify({ detail: result.detail }), updatedAt: new Date().toISOString() })
              if (delivered.status === 'verified' && s.settings.mode === 'voice_transcript' && !signal.aborted)
                s.targetTransferred = this.deps.observeInput?.(s.id, result.text, s.target) === true
            } catch { result.detail = 'injection_history_save_failed' }
          }
        }
      }
      notify(result.success ? 'done' : 'error', result.detail, result.text)
      return result
    } catch (e) {
      const detail = signal.aborted ? 'cancelled' : (e as Error).message
      if (saved && row)
        await this.deps.saveHistory({
          id: s.id,
          status: signal.aborted ? 'cancelled' : 'failed',
          debugInfo: JSON.stringify({ detail }),
          updatedAt: new Date().toISOString(),
        })
      notify(signal.aborted ? 'cancelled' : 'error', detail)
      return { success: false, detail }
    } finally {
      s.controller.abort()
      s.live?.dispose()
      if (!s.targetTransferred) this.deps.releaseTarget?.(s.target)
      if (saved) this.deps.changed()
      if (this.session === s) this.session = null
    }
  }
  onCancel() {
    const pending = this.starting
    if (pending) {
      this.starting = null
      pending.controller.abort()
      this.notify({ phase: 'cancelled', audioId: pending.id })
    }
    const s = this.session
    if (!s) return
    s.controller.abort()
    s.live?.dispose()
    if (!s.targetTransferred) this.deps.releaseTarget?.(s.target)
    this.notify({ phase: 'cancelled', audioId: s.id })
    this.session = null
  }
  dispose() {
    this.rendererVoice.dispose()
    this.onCancel()
  }
}
