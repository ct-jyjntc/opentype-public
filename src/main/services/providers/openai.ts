import { audioFormat } from './audio-format'
// OpenAI 协议 provider。
//
// 与自建协议的核心差异：OpenAI 只有**裸转写**，没有润色与交付决策。
// 要达到「杂乱想法 → 清晰文字」的效果，必须补一次 chat 调用，
// 并把上下文（应用名、输入框内容、选中文本）自己编排进 prompt。
//
// 端点（已核实官方文档）：
//   POST /v1/audio/transcriptions   multipart: file + model + response_format
//   POST /v1/chat/completions       JSON: model + messages

import { FormData as UndiciFormData } from 'undici'
import { serviceRequest as request } from '../network'
import { serviceEndpoint } from '../../../shared/network-policy'
import type { SpeechProvider, TranscribeParams, TranscribeResult, ProviderConfig } from './types'
import { refineTranscript } from './refinement'

const TRANSCRIBE_TIMEOUT_MS = 60_000
const REFINE_TIMEOUT_MS = 30_000

/** 各模式对应的润色指令。这是 OpenAI 路径下「产品智能」的所在。 */
const REFINE_SYSTEM_PROMPTS: Record<string, string> = {
  voice_transcript: [
    '你是一个听写润色助手。用户用语音口述了一段内容，语音识别结果会有同音字错误、',
    '口语赘词（嗯、那个、就是说）、以及断句混乱。',
    '请修正错别字、去掉口语赘词、补全标点，输出连贯的书面文字。',
    '严格保持原意，不要添加用户没说过的内容，不要改变语气正式程度。',
    '只输出润色后的文本，不要任何解释或前后缀。'
  ].join(''),
  voice_command: [
    '你是一个文本编辑助手。用户对选中的文本下达了语音指令。',
    '请根据指令修改文本，只输出修改后的文本，不要解释。'
  ].join(''),
  voice_translation: [
    '你是一个翻译助手。请把用户口述的内容翻译成目标语言，',
    '保持原意的同时让译文自然地道。只输出译文。'
  ].join('')
}

export class OpenAIProvider implements SpeechProvider {
  readonly name = 'openai'

  constructor(private readonly config: ProviderConfig) {}

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    // 阶段一：转写
    const asr = await this.callTranscription(params)
    if (!asr.success) return asr

    const rawText = asr.text ?? ''
    if (!rawText) return { success: false, detail: 'empty_transcription' }
    if (this.config.refinement) return refineTranscript(rawText, params, this.config.refinement)

    // 阶段二：润色（可选）。关闭时直接返回 ASR 原文。
    if (this.config.refine === false && params.mode === 'voice_transcript') {
      return { success: true, text: rawText, rawText }
    }

    const refined = await this.callRefine(rawText, params)
    if (params.signal?.aborted) return { success: false, rawText, detail: 'cancelled' }
    if (!refined) return params.mode === 'voice_transcript'
      ? { success: true, text: rawText, rawText, detail: 'refine_failed' }
      : { success: false, rawText, detail: 'refine_failed' }

    return { success: true, text: refined, rawText }
  }

  /** POST /v1/audio/transcriptions */
  private async callTranscription(params: TranscribeParams): Promise<TranscribeResult> {
    const form = new UndiciFormData()
    const format = audioFormat(params.audio)
    const blob = new Blob([params.audio as BlobPart], { type: format.mime })
    // OpenAI 的音频字段名是 file，不是 audio_file
    form.append('file', blob, `${params.audioId}.${format.extension}`)
    form.append('model', this.config.model ?? 'gpt-4o-transcribe')
    // json 格式返回 {text, languages, usage}
    form.append('response_format', 'json')
    // Only the spoken language belongs in the ASR request. OpenAI auto-detects
    // when omitted; neither "auto" nor the translation target is an ASR hint.
    const lang = params.parameters?.language
    if (typeof lang === 'string' && lang && lang !== 'auto') form.append('language', lang)

    try {
      const res = await request(serviceEndpoint(this.config.baseUrl, '/v1/audio/transcriptions'), {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: AbortSignal.any([AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS), ...(params.signal ? [params.signal] : [])])
      })

      const payload = await res.body.json() as Record<string, any>

      if (res.statusCode === 429) {
        // 配额/限流：归一化为 paywall 语义
        return { success: false, detail: 'rate_limited', paywall: payload?.error ?? null }
      }
      if (res.statusCode >= 400) {
        return {
          success: false,
          detail: payload?.error?.message ?? `http_${res.statusCode}`,
          code: res.statusCode
        }
      }

      // 检测到的语言：OpenAI 返回 languages: [{code}]
      const detected = Array.isArray(payload?.languages) ? payload.languages[0]?.code : undefined
      if (detected) params.audioContext.detected_language = detected

      return { success: true, text: payload?.text ?? '' }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return { success: false, detail: params.signal?.aborted ? 'cancelled' : aborted ? 'timeout' : (err as Error).message }
    }
  }

  /**
   * POST /v1/chat/completions
   *
   * 这一层是 OpenAI 路径下必须自己补的：把上下文与模式指令编排进 prompt。
   * 服务端内部做的就是这件事，只是对客户端不可见。
   */
  private async callRefine(rawText: string, params: TranscribeParams): Promise<string | null> {
    const system = REFINE_SYSTEM_PROMPTS[params.mode] ?? REFINE_SYSTEM_PROMPTS.voice_transcript
    const contextBlock = this.buildContextBlock(params)

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system }
    ]
    if (contextBlock) {
      messages.push({ role: 'system', content: contextBlock })
    }
    messages.push({ role: 'user', content: this.buildUserMessage(rawText, params) })

    try {
      const res = await request(serviceEndpoint(this.config.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.refineModel ?? 'gpt-4o-mini',
          messages,
          // 润色任务需要确定性：temperature 高会让同一段话每次结果不同
          temperature: 0.2
        }),
        signal: AbortSignal.any([AbortSignal.timeout(REFINE_TIMEOUT_MS), ...(params.signal ? [params.signal] : [])])
      })

      if (res.statusCode >= 400) { await res.body.dump(); return null }
      const payload = await res.body.json() as Record<string, any>
      const content = payload?.choices?.[0]?.message?.content
      return typeof content === 'string' && content.trim() ? content.trim() : null
    } catch {
      return null
    }
  }

  /**
   * 把上下文编成 prompt。
   *
   * 只传对润色真正有用的字段。输入框已有内容最有价值——
   * 模型据此判断该用正式还是口语风格、术语怎么拼。
   * 敏感应用已在 pipeline 层脱敏，这里拿到的就是空值。
   */
  private buildContextBlock(params: TranscribeParams): string {
    const ctx = params.audioContext
    const lines: string[] = []

    if (ctx.app_name) lines.push(`用户正在使用的应用：${ctx.app_name}`)
    if (ctx.web_domain) lines.push(`网页域名：${ctx.web_domain}`)
    if (ctx.window_title) lines.push(`窗口标题：${ctx.window_title}`)
    if (ctx.input_context) {
      // 截断：过长的上下文会挤占 token 且收益递减
      const snippet = String(ctx.input_context).slice(-800)
      lines.push(`输入框已有内容（供参考语气与术语）：\n${snippet}`)
    }

    return lines.length ? lines.join('\n') : ''
  }

  private buildUserMessage(rawText: string, params: TranscribeParams): string {
    if (params.mode === 'voice_command') {
      const selected = params.parameters?.selected_text
      if (typeof selected === 'string' && selected) {
        return `选中文本：\n${selected}\n\n语音指令：${rawText}`
      }
      return `语音指令：${rawText}`
    }
    if (params.mode === 'voice_translation') {
      const target = params.parameters?.output_language
      const targetLine = typeof target === 'string' && target ? `目标语言：${target}\n\n` : ''
      return `${targetLine}原文：${rawText}`
    }
    return rawText
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': `OpenType/${this.config.appVersion}`
    }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    return headers
  }
}
