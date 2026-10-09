import { audioFormat } from './audio-format'
// 自建服务端协议 provider（一次调用完成转写 + 润色 + 交付决策）。
//
// 一次 multipart 调用完成「转写 + 润色 + 交付决策」。
// 服务端返回 refine_text（润色稿）与 delivery（交付方式），客户端不做二次处理。

import { FormData as UndiciFormData } from 'undici'
import { serviceRequest as request } from '../network'
import { serviceEndpoint } from '../../../shared/network-policy'
import { SERVER_MODE, VOICE_FLOW_TIMEOUT_MS } from '../protocol'
import { normalizeGrounding } from './types'
import type { SpeechProvider, TranscribeParams, TranscribeResult, ProviderConfig } from './types'

export class CustomProvider implements SpeechProvider {
  readonly name = 'custom'

  constructor(private readonly config: ProviderConfig) {}

  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    const form = new UndiciFormData()
    form.append('audio_id', params.audioId)
    // 关键：上传的是服务端 mode 值，不是本地枚举
    // （本地 voice_command 在服务端叫 ask_anything）
    form.append('mode', SERVER_MODE[params.mode])
    form.append('duration', String(params.duration))
    form.append('is_retry', String(params.isRetry ?? false))
    if (params.deviceName) form.append('device_name', params.deviceName)

    const format = audioFormat(params.audio)
    const blob = new Blob([params.audio as BlobPart], { type: format.mime })
    form.append('audio_file', blob, `${params.audioId}.${format.extension}`)
    form.append('audio_metadata', JSON.stringify(params.audioMetadata))
    form.append('audio_context', JSON.stringify(params.audioContext))
    form.append('parameters', JSON.stringify(params.parameters ?? {}))

    try {
      const res = await request(serviceEndpoint(this.config.baseUrl, '/ai/voice_flow'), {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: form,
        signal: AbortSignal.any([AbortSignal.timeout(VOICE_FLOW_TIMEOUT_MS), ...(params.signal ? [params.signal] : [])])
      })

      const payload = await res.body.json() as Record<string, any>

      // 配额耗尽走单独分支：前端应展示升级引导而非错误
      if (payload?.important_notification) {
        return { success: false, paywall: payload.important_notification, detail: payload.detail ?? '' }
      }
      if (payload?.status === 'OK' && payload?.data) {
        if (payload.data.refine_failed && params.mode !== 'voice_transcript') {
          return { success: false, rawText: payload.data.raw_text ?? '', detail: 'refine_failed' }
        }
        return {
          success: true,
          text: payload.data.refine_text ?? '',
          rawText: payload.data.raw_text ?? '',
          detail: payload.data.refine_failed ? 'refine_failed' : undefined,
          delivery: payload.data.delivery,
          userPrompt: payload.data.user_prompt,
          webMetadata: payload.data.web_metadata,
          grounding: normalizeGrounding(payload.data.web_metadata ?? payload.data),
          externalAction: payload.data.external_action
        }
      }
      return {
        success: false,
        detail: payload?.detail ?? payload?.msg ?? `http_${res.statusCode}`,
        code: payload?.code
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return { success: false, detail: params.signal?.aborted ? 'cancelled' : aborted ? 'timeout' : (err as Error).message }
    }
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'user-agent': `OpenType/${this.config.appVersion}`
    }
    if (this.config.getDeviceId) headers['x-device-id'] = this.config.getDeviceId()
    const token = this.config.apiKey || await this.config.getToken?.()
    // 无 token 时不发 Authorization：让服务端明确区分「未登录」与「token 失效」
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }
}
