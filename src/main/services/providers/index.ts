import { audioFormat } from './audio-format'
import { serviceEndpoint } from '../../../shared/network-policy'
import { serviceRequest as request } from '../network'
// provider 工厂与本地回退。
//
// 提供三层选择：自建服务端协议 / OpenAI 兼容协议 / 本地模型。
// 之所以需要本地回退：调试时不希望每次都消耗云端配额，且离线也要能验证链路。

import { CustomProvider } from './custom'
import { OpenAIProvider } from './openai'
import { refineTranscript } from './refinement'
import type { SpeechProvider, ProviderConfig, TranscribeParams, TranscribeResult } from './types'

/**
 * 本地模型 provider。
 *
 * 指向本机 OpenType 网关，由网关适配 whisper.cpp 并编排润色。
 * 网关须位于本机；whisper.cpp 的裸 /inference 端点不能直接使用。
 */
export class LocalProvider implements SpeechProvider {
  readonly name = 'local'

  constructor(private readonly config: ProviderConfig) {}

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    try {
      serviceEndpoint(this.config.baseUrl, '', true)
    } catch { return { success: false, detail: 'invalid_local_endpoint', code: 400 } }
    const { FormData: UndiciFormData } = await import('undici')
    const form = new UndiciFormData()
    const format = audioFormat(params.audio)
    const blob = new Blob([params.audio as BlobPart], { type: format.mime })
    form.append('file', blob, `${params.audioId}.${format.extension}`)
    form.append('model', this.config.model ?? 'whisper-1')
    form.append('response_format', 'json')

    // 下面三个字段不是 OpenAI 标准，但 OpenType 网关（gateway/src/server.ts）会识别：
    // 有 mode 就编排润色，有 audio_context 就注入写作语境。
    // 直连 whisper.cpp / OpenAI 时这些字段被忽略，不影响兼容性。
    form.append('mode', this.config.refinement ? 'voice_transcript' : params.mode)
    if (this.config.refinement || this.config.refine === false) form.append('refine', 'false')
    if (!this.config.refinement) {
      form.append('audio_context', JSON.stringify(params.audioContext))
      form.append('parameters', JSON.stringify(params.parameters ?? {}))
    }
    if (params.duration) form.append('duration', String(params.duration))
    // 语言提示必须单独放到顶层：网关从顶层字段读 language 转发给 whisper.cpp，
    // 埋在 parameters JSON 里它读不到。whisper 缺省 language=en，不下发会把
    // 中文按英文解码。
    const lang = params.parameters?.language
    if (typeof lang === 'string' && lang) form.append('language', lang)

    try {
      const res = await request(serviceEndpoint(this.config.baseUrl, '/v1/audio/transcriptions', true), {
        method: 'POST',
        headers: { 'user-agent': `OpenType/${this.config.appVersion}` },
        body: form,
        signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(params.signal ? [params.signal] : [])])
      })
      const payload = await res.body.json() as Record<string, any>
      if (res.statusCode >= 400) {
        return {
          success: false,
          rawText: payload?.raw_text,
          detail: payload?.error?.message ?? `http_${res.statusCode}`,
          code: res.statusCode
        }
      }
      const text = payload?.text ?? ''
      if (!text) return { success: false, detail: 'empty_transcription' }
      if (this.config.refinement) return refineTranscript(payload?.raw_text ?? text, params, this.config.refinement)
      // 网关返回的是润色后的文本；直连时它与原文相同
      return { success: true, text, rawText: payload?.raw_text ?? text, detail: payload?.refine_failed ? 'refine_failed' : undefined }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return { success: false, detail: params.signal?.aborted ? 'cancelled' : aborted ? 'timeout' : (err as Error).message }
    }
  }
}

/** 按配置创建 provider。 */
export function createProvider(config: ProviderConfig): SpeechProvider {
  switch (config.kind) {
    case 'openai':
      return new OpenAIProvider(config)
    case 'custom':
      return new CustomProvider(config)
    default:
      return new LocalProvider(config)
  }
}

/**
 * 带故障转移的 provider 包装。
 *
 * 主 provider 失败时自动降级到备用（通常是本地模型）。
 * 只对「网络/服务不可用」类失败转移——参数错误、配额不足转移也无意义。
 */
export class FallbackProvider implements SpeechProvider {
  readonly name: string

  constructor(
    private readonly primary: SpeechProvider,
    private readonly fallback: SpeechProvider
  ) {
    this.name = `${primary.name}+${fallback.name}`
  }

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    const result = await this.primary.transcribe(params)
    if (result.success) return result
    if (params.signal?.aborted || result.detail === 'cancelled') return { success: false, detail: 'cancelled' }
    if (result.code && result.code >= 400 && result.code < 500 && result.code !== 408) return result
    if (result.detail === 'refine_failed') return result

    // 这些失败不是 provider 的问题，转移无意义
    const nonTransferable = ['timeout', 'rate_limited', 'empty_transcription']
    if (result.paywall) return result
    if (result.detail && nonTransferable.some((k) => result.detail!.includes(k))) {
      // 超时仍值得试备用（可能是主服务端慢），其余直接返回
      if (!result.detail.includes('timeout')) return result
    }

    const fb = await this.fallback.transcribe(params)
    // 备用也失败时，返回主 provider 的错误（更可能是用户关心的）
    return fb.success ? fb : result
  }
}

export type { SpeechProvider, ProviderConfig, TranscribeParams, TranscribeResult } from './types'
