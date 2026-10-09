// 主链路编排：热键触发 -> 采集上下文 -> 录音 -> 编码 -> 上传 -> 注入 -> 落库。
//
// 时序上最容易踩的三个坑，这里都做了处理：
// 1. 上下文必须在录音「开始前」采集。录音一旦启动，浮窗会抢走焦点，
//    此时再读 AXFocusedUIElement 拿到的是浮窗自己，上下文就丢了。
// 2. 注入前必须重新激活目标应用。录音期间用户可能切走了窗口，
//    不激活就会把文本打进错误的应用。
// 3. 落库要在注入之后。注入失败时记录要标 failed，用户才能在历史里重试。

import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { InputHelper, ContextHelper, UtilHelper } from '../native/ffi'
import type { SpeechProvider, TranscribeResult } from './providers'
import type { CaptureMode } from '../db/schema'
import type { HistoryInsert, HistoryRow } from '../db'
import { RendererVoiceService } from './renderer-voice'
import { decideContext } from './privacy'
import { activateAppSilently, waitForActivation } from './activate'
import { AUDIO_PARAMS } from './protocol'

export interface CaptureContext {
  appName: string
  bundleId: string
  pid: number
  windowTitle: string
  webUrl: string
  webDomain: string
  selectedText: string
  inputContext: string
}

export interface PipelineDeps {
  /** 语音识别 provider（自建协议 / OpenAI 协议 / 本地模型） */
  provider: SpeechProvider
  /** 把 Float32 PCM 编码成 Ogg/Opus，由音频服务提供 */
  encode: (pcm: Float32Array[], sampleRate: number) => Promise<Uint8Array>
  /** 落库 */
  saveHistory: (record: HistoryInsert) => Promise<void>
  /** 通知渲染层更新浮窗状态 */
  notify: (state: PipelineState) => void
  /** 读取用户配置（模式、目标语言、是否自动注入等） */
  getConfig: () => PipelineConfig
  /**
   * 按 audioId 读回录音期间写入的记录。
   *
   * 为什么必须有：真实前端调 audio:ai-voice-flow 时**不传 mode**，
   * 它把 mode / audio_metadata / mode_meta / mic_device_info 提前写进本地库，
   * 主进程再按 audioId 取回来。不实现这一步，所有请求都会退化成
   * 默认的 voice_transcript 模式，翻译与指令模式永久失效。
   */
  loadHistory?: (audioId: string) => Promise<HistoryRow | null>
}

export interface PipelineConfig {
  mode: CaptureMode
  outputLanguage?: string
  /**
   * 识别语言提示，传给 ASR。
   *
   * 单独一个字段而不是复用 outputLanguage：前者决定「音频里说的是什么语言」，
   * 后者是「翻译成什么语言」。翻译模式下两者必然不同，混用会把译文语言
   * 当成原文语言送给 ASR，导致整段识别崩掉。
   */
  asrLanguage?: string
  autoInject: boolean
  /** 目标应用在黑名单域名下时，不上传上下文 */
  blacklistDomains: string[]
  appVersion: string
}

export interface PipelineState {
  phase: 'idle' | 'recording' | 'encoding' | 'uploading' | 'injecting' | 'done' | 'error' | 'cancelled'
  audioId?: string
  level?: number
  text?: string
  detail?: string
}

export class VoicePipeline {
  private chunks: Float32Array[] = []
  private sampleRate = 16000
  private startedAt = 0
  private context: CaptureContext | null = null
  private currentAudioId: string | null = null
  private cancelled = false
  private busy = false
  /** 会话级取消信号：用户按 Esc 时中断在途网络请求，避免白等 40 秒 */
  private abortController: AbortController | null = null

  private rendererVoice: RendererVoiceService

  constructor(private deps: PipelineDeps) {
    this.rendererVoice = new RendererVoiceService({
      getProvider: () => this.deps.provider,
      loadHistory: id => this.deps.loadHistory?.(id) ?? Promise.resolve(null),
      getConfig: () => this.deps.getConfig()
    })
  }

  voiceFlowForRenderer(params: Record<string, unknown>): Promise<unknown> {
    return this.rendererVoice.run(params)
  }

  cancelByAbortId(abortId: string): void {
    this.rendererVoice.cancel(abortId)
  }

  dispose(): void {
    this.rendererVoice.dispose()
    this.onCancel()
  }

  /** 运行时替换 provider（配置变更时调用）。 */
  setProvider(provider: SpeechProvider): void {
    this.deps = { ...this.deps, provider }
  }

  /** 热键按下：采集上下文并开始接收音频。 */
  async onStart(): Promise<{ audioId: string } | null> {
    if (this.busy) return null
    this.busy = true
    this.cancelled = false
    this.chunks = []
    this.startedAt = Date.now()
    this.abortController = new AbortController()
    this.currentAudioId = randomUUID()

    // 先采上下文，再让浮窗出现——顺序反了就会采到浮窗自己的焦点
    this.context = this.collectContext()

    // 录音前检查：合盖或系统静音时录不到有效音频，提前告知用户
    if (!UtilHelper.isLidOpen()) {
      this.deps.notify({ phase: 'error', detail: 'lid_closed' })
      this.reset()
      return null
    }

    this.deps.notify({ phase: 'recording', audioId: this.currentAudioId })
    return { audioId: this.currentAudioId }
  }

  /**
   * 音量上报。独立于音频数据：只更新浮窗波形，不进入编码链路。
   * 高频调用，所以不做任何状态写入，只透传给 UI。
   */
  pushLevel(level: number): void {
    if (!this.busy) return
    this.deps.notify({ phase: 'recording', audioId: this.currentAudioId ?? undefined, level })
  }

  /** 渲染层每收到一块 PCM 就转给主进程。 */
  pushAudio(pcm: Float32Array, sampleRate: number, level: number): void {
    if (!this.busy) return

    this.sampleRate = sampleRate
    this.chunks.push(pcm)
    this.deps.notify({ phase: 'recording', audioId: this.currentAudioId ?? undefined, level })
  }

  /** 热键松开：走完编码 -> 上传 -> 注入 -> 落库。 */
  async onStop(): Promise<TranscribeResult | null> {
    // 已取消的会话不再处理音频：取消后仍可能有在途分块到达
    if (this.cancelled || !this.busy || !this.currentAudioId) return null

    const audioId = this.currentAudioId
    const duration = (Date.now() - this.startedAt) / 1000

    // Only an empty capture is skipped; short utterances are valid.
    if (!this.chunks.some(chunk => chunk.length > 0)) {
      this.deps.notify({ phase: 'cancelled', detail: 'empty_audio' })
      this.reset()
      return null
    }

    try {
      this.deps.notify({ phase: 'encoding', audioId })
      const encoded = await this.deps.encode(this.chunks, this.sampleRate)

      this.deps.notify({ phase: 'uploading', audioId })
      const config = this.deps.getConfig()
      const result = await this.deps.provider.transcribe({
        mode: config.mode,
        audio: encoded,
        audioId,
        duration,
        audioMetadata: {
          audio_duration: duration,
          sample_rate: this.sampleRate,
          channel_count: AUDIO_PARAMS.channels,
          sample_size: AUDIO_PARAMS.sampleSize,
          encoding: 'opus',
          bitrate: AUDIO_PARAMS.opusBitrate,
          frame_size: AUDIO_PARAMS.opusFrameSizeMs
        },
        audioContext: this.buildAudioContext(config),
        parameters: this.buildParameters(config),
        deviceName: this.context?.appName,
        isRetry: false,
        signal: this.abortController?.signal
      })

      if (!result.success) {
        this.deps.notify({ phase: 'error', audioId, detail: result.detail })
        await this.persist(audioId, duration, null, result)
        this.reset()
        return result
      }

      // 注入：只有纯文本模式直接注入；voice_command 由服务端返回 delivery 决定动作
      if (config.autoInject && result.text && result.delivery !== 'external') {
        this.deps.notify({ phase: 'injecting', audioId, text: result.text })
        await this.inject(result.text)
      }

      await this.persist(audioId, duration, result.text ?? null, result)
      this.deps.notify({ phase: 'done', audioId, text: result.text })
      this.reset()
      return result
    } catch (err) {
      this.deps.notify({ phase: 'error', audioId, detail: (err as Error).message })
      this.reset()
      return { success: false, detail: (err as Error).message }
    }
  }

  /** Esc 取消：丢弃音频，不产生任何记录。 */
  onCancel(): void {
    if (!this.busy) return
    this.cancelled = true
    // 中断在途网络请求，否则用户取消后还要等超时
    this.abortController?.abort()
    this.deps.notify({ phase: 'cancelled', audioId: this.currentAudioId ?? undefined })
    this.reset()
  }

  /**
   * 注入前把焦点交还给原目标应用，否则文本会打进浮窗。
   *
   * 激活走跨平台实现（AppleScript / PowerShell / wmctrl），
   * 因为注入期间焦点可能已经被用户切走——不激活就会打错窗口。
   */
  private async inject(text: string): Promise<void> {
    const target = this.context
    if (target?.bundleId) {
      const result = await activateAppSilently(target.bundleId)
      if (result.ok) {
        // 给窗口系统时间完成焦点切换，太快注入会丢字符
        waitForActivation(120)
      }
      // 激活失败仍继续注入：至少在当前焦点处写入，比完全丢失好
    }
    InputHelper.insertText(text)
  }

  /** 采集前台应用与输入框上下文。 */
  private collectContext(): CaptureContext {
    const appInfo = ContextHelper.getFocusedAppInfo()
    const input = ContextHelper.getFocusedInputInfo()
    let webUrl = ''
    let webDomain = ''
    try {
      webUrl = input.web?.url ?? ''
      if (webUrl) webDomain = new URL(webUrl).hostname
    } catch { /* 非 URL 的 web area，忽略 */ }

    return {
      appName: appInfo?.appName ?? input.appName ?? '',
      bundleId: appInfo?.bundleId ?? input.bundleId ?? '',
      pid: appInfo?.pid ?? input.pid ?? 0,
      windowTitle: input.web?.title ?? '',
      webUrl,
      webDomain,
      selectedText: input.selectedText ?? '',
      inputContext: (input.focusedValue ?? '').slice(0, 2000)
    }
  }

  /**
   * 构造上传的 audio_context。
   * 经隐私护栏判定：敏感应用与黑名单域名下，输入框内容与 URL 全部置空。
   */
  private buildAudioContext(config: PipelineConfig): Record<string, unknown> {
    const ctx = this.context
    if (!ctx) return {}

    const decision = decideContext(ctx.bundleId, ctx.webDomain, ctx.webUrl, ctx.appName)
    // 域名黑名单优先于一切：即使应用本身不在敏感清单里也要脱敏
    const blacklisted = config.blacklistDomains.some(
      (d) => d && ctx.webDomain && ctx.webDomain.endsWith(d)
    )
    const redacted = !decision.allowContext || blacklisted

    return {
      app_name: ctx.appName,
      bundle_id: ctx.bundleId,
      window_title: redacted ? '' : ctx.windowTitle,
      web_domain: ctx.webDomain,
      web_url: redacted ? '' : ctx.webUrl,
      // 输入框内容是最敏感的部分：密码框、聊天窗口都在这里
      input_context: redacted ? '' : ctx.inputContext,
      is_browser: ctx.bundleId ? ContextHelper.isBrowserApp(ctx.bundleId) : false,
      redacted,
      redact_reason: redacted ? (decision.reason === 'default' ? 'remote_blacklist' : decision.reason) : null
    }
  }

  private buildParameters(config: PipelineConfig): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    // ASR 语言提示必须显式下发：whisper.cpp 的 language 缺省是 en 而非 auto，
    // 不传就会把中文音频按英文解码，输出一串同音乱码。
    if (config.asrLanguage) params.language = config.asrLanguage
    if (config.mode === 'voice_command' && this.context?.selectedText) {
      params.selected_text = this.context.selectedText
    }
    if (config.mode === 'voice_translation' && config.outputLanguage) {
      params.output_language = config.outputLanguage
    }
    return params
  }

  private async persist(
    audioId: string,
    duration: number,
    refinedText: string | null,
    result: TranscribeResult
  ): Promise<void> {
    const ctx = this.context
    const now = new Date().toISOString()
    await this.deps.saveHistory({
      id: audioId,
      status: result.success ? 'completed' : 'failed',
      mode: this.deps.getConfig().mode,
      refinedText,
      duration,
      focusedAppName: ctx?.appName ?? null,
      focusedAppBundleId: ctx?.bundleId ?? null,
      focusedAppWindowTitle: ctx?.windowTitle ?? null,
      focusedAppWebUrl: ctx?.webUrl ?? null,
      focusedAppWebDomain: ctx?.webDomain ?? null,
      inputContext: ctx?.inputContext ?? null,
      modeMeta: JSON.stringify({ delivery: result.delivery ?? null }),
      appVersion: this.deps.getConfig().appVersion,
      debugInfo: result.detail ? JSON.stringify({ detail: result.detail }) : null,
      syncStatus: result.success && refinedText ? 'pending_upload' : 'sync_failed',
      createdAt: now,
      updatedAt: now
    })
  }

  private reset(): void {
    this.busy = false
    this.abortController = null
    this.chunks = []
    this.context = null
    this.currentAudioId = null
    this.cancelled = false
  }

  get isBusy(): boolean {
    return this.busy
  }
}

export const APP_VERSION = app.getVersion()
