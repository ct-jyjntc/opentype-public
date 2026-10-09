// 云端 API 客户端。
//
// 从目标应用的协议里学到的两个关键设计：
// 1. 音频走 multipart 上传（audio_file + audio_context + audio_metadata + parameters），
//    而不是 base64 塞进 JSON——后者体积膨胀 33% 且无法流式。
// 2. 上下文随请求一起上传，服务端才能做「结合当前输入框内容」的润色，
//    否则模型只能做通用转写，无法纠正术语与语气。

import { FormData as UndiciFormData } from 'undici'
import { serviceRequest as request } from './network'
import { SERVER_MODE, VOICE_FLOW_TIMEOUT_MS, type LocalMode } from './protocol'
import { serviceEndpoint } from '../../shared/network-policy'

// 协议常量集中在 protocol.ts，此处转发以保持既有引用可用
export { SERVER_MODE, type LocalMode }

export interface VoiceFlowParams {
  mode: LocalMode
  /** Opus/Ogg 编码后的音频字节 */
  audio: Uint8Array
  audioId: string
  duration: number
  /** 采样率、声道、位深、编码格式 */
  audioMetadata: Record<string, unknown>
  /** 前台应用与输入框上下文，用于提升润色准确度 */
  audioContext: Record<string, unknown>
  /** 模式专属参数：voice_command 传 selected_text，voice_translation 传 output_language */
  parameters?: Record<string, unknown>
  /** 设备名，服务端用于统计不同麦克风的识别质量 */
  deviceName?: string
  isRetry?: boolean
}

export interface VoiceFlowResult {
  success: boolean
  /** AI 润色后的最终文本 */
  text?: string
  /** ASR 原始输出，用于对照与重试 */
  rawText?: string
  /**
   * 交付方式。'external' 表示服务端已驱动外部动作（建文档/发邮件等），
   * 此时客户端不应再注入文本，否则会重复。
   */
  delivery?: string
  /** 服务端生成的用户提示语（ask_anything 模式的回答） */
  userPrompt?: string
  /** 联网检索的元数据 */
  webMetadata?: unknown
  /** 外部动作描述 */
  externalAction?: unknown
  detail?: string
  code?: number
  /** 配额不足时服务端返回的升级提示 */
  paywall?: unknown
}

export interface ApiClientOptions {
  baseUrl: string
  appVersion: string
  getToken: () => Promise<string | null>
  /** 设备标识，用于按设备维度做风控与配额 */
  getDeviceId: () => string
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    serviceEndpoint(this.options.baseUrl)
    const headers: Record<string, string> = {
      'user-agent': `OpenType/${this.options.appVersion}`,
      'x-device-id': this.options.getDeviceId(),
      ...extra
    }
    const token = await this.options.getToken()
    // 无 token 时不发 Authorization 头：让服务端明确区分「未登录」与「token 失效」
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  /** 语音主链路：上传音频，取回润色后的文本。 */
  async voiceFlow(params: VoiceFlowParams): Promise<VoiceFlowResult> {
    const form = new UndiciFormData()
    form.append('audio_id', params.audioId)
    form.append('mode', SERVER_MODE[params.mode])
    form.append('duration', String(params.duration))
    form.append('is_retry', String(params.isRetry ?? false))
    if (params.deviceName) form.append('device_name', params.deviceName)

    // 用 Uint8Array 直接构造 Blob，避免 Node Buffer 与浏览器 Blob 的类型摩擦
    const blob = new Blob([params.audio as BlobPart], { type: 'audio/ogg' })
    form.append('audio_file', blob, `${params.audioId}.ogg`)
    form.append('audio_metadata', JSON.stringify(params.audioMetadata))
    form.append('audio_context', JSON.stringify(params.audioContext))
    form.append('parameters', JSON.stringify(params.parameters ?? {}))

    // 超时保护：长语音 + 弱网下过短会误判失败，但也不能无限等，否则浮窗一直转圈
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VOICE_FLOW_TIMEOUT_MS)

    try {
      const res = await request(serviceEndpoint(this.options.baseUrl, '/ai/voice_flow'), {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: form,
        signal: controller.signal
      })

      const payload = await res.body.json() as Record<string, any>

      // 配额耗尽走单独分支：此时前端应展示升级引导而非错误提示
      if (payload?.important_notification) {
        return { success: false, paywall: payload.important_notification, detail: payload.detail ?? '' }
      }
      if (payload?.status === 'OK' && payload?.data) {
        return {
          success: true,
          text: payload.data.refine_text ?? '',
          rawText: payload.data.raw_text ?? '',
          delivery: payload.data.delivery,
          userPrompt: payload.data.user_prompt,
          webMetadata: payload.data.web_metadata,
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
      return { success: false, detail: aborted ? 'timeout' : (err as Error).message }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 刷新 token。refresh 接口不携带旧 token，否则过期 token 会导致刷新也失败。 */
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const res = await request(serviceEndpoint(this.options.baseUrl, '/oauth/refresh_access_token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `OpenType/${this.options.appVersion}` },
      body: JSON.stringify({ refresh_token: refreshToken })
    })
    const payload = await res.body.json() as Record<string, any>
    if (payload?.status !== 'OK' || !payload?.data?.access_token) return null
    return {
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token ?? refreshToken
    }
  }

  /** 拉取服务端下发的域名黑名单：在密码框、银行页面等场景禁止采集上下文。 */
  async fetchBlacklistDomains(): Promise<string[]> {
    const res = await request(serviceEndpoint(this.options.baseUrl, '/app/get_blacklist_domain'), {
      method: 'POST',
      headers: await this.buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({})
    })
    const payload = await res.body.json() as Record<string, any>
    const data = payload?.data?.data
    return Array.isArray(data) ? data : []
  }

  /** 历史增量同步：分页推送，返回已确认的 id 以便本地标记 synced。 */
  async pushHistory(records: Array<Record<string, unknown>>): Promise<{ ok: boolean; acceptedIds: string[] }> {
    const res = await request(serviceEndpoint(this.options.baseUrl, '/transcription_history/push'), {
      method: 'POST',
      headers: await this.buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ records })
    })
    const payload = await res.body.json() as Record<string, any>
    if (payload?.status !== 'OK') return { ok: false, acceptedIds: [] }
    return { ok: true, acceptedIds: (payload.data?.accepted ?? records.map((r) => r.id)) as string[] }
  }
}
