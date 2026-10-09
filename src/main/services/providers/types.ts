// 语音识别 provider 抽象。
//
// 为什么要抽象：自建服务端协议把「转写 + 润色 + 交付决策」放在服务端一次完成，
// 而 OpenAI 只有裸转写。二者的请求形状、调用次数、响应结构都不同。
// 上层 pipeline 只关心「给我一段音频，还我一段润色后的文本」，具体怎么实现由 provider 决定。

import type { LocalMode } from '../protocol'
import type { RefinementConfig } from './refinement'
import type { ProcessingProgress } from '../../../shared/processing'

export interface TranscribeParams {
  mode: LocalMode
  /** Ogg/Opus 编码后的音频 */
  audio: Uint8Array
  audioId: string
  duration: number
  audioMetadata: Record<string, unknown>
  /** 前台应用与输入框上下文 */
  audioContext: Record<string, unknown>
  /** 模式专属参数：voice_command 传 selected_text，voice_translation 传 output_language */
  parameters?: Record<string, unknown>
  deviceName?: string
  isRetry?: boolean
  signal?: AbortSignal
  onProgress?: (progress: ProcessingProgress) => void
}

export interface TranscribeResult {
  success: boolean
  /** 最终文本（已润色，若有润色环节） */
  text?: string
  /** ASR 原始输出，用于对照与重试 */
  rawText?: string
  /**
   * 交付方式。
   * 'external' 表示服务端已驱动外部动作，客户端不应再注入文本。
   */
  delivery?: string
  userPrompt?: string
  /** 服务端返回的原始联网元数据（未归一化） */
  webMetadata?: unknown
  /**
   * 联网检索的来源引用。
   *
   * 渲染层的 grounding_chunks / grounding_supports 结构：
   * AI 回答可携带网页来源（域名/标题/URL/图标），前端渲染成引用列表。
   * 对应服务端用 Google Vertex AI 的检索增强。
   */
  grounding?: GroundingInfo
  externalAction?: unknown
  detail?: string
  code?: number
  /** 配额不足时的升级提示 */
  paywall?: unknown
}

/**
 * provider 契约。
 *
 * 实现者需要保证：成功时 `text` 非空；失败时给出可读的 `detail`。
 * `delivery` 未实现可留空——上层默认按「直接注入」处理。
 */
export interface SpeechProvider {
  readonly name: string
  transcribe(params: TranscribeParams): Promise<TranscribeResult>
  /** Optional recognition during recording; refinement and delivery happen only at finish. */
  startLiveTranscription?(options: { language: string; signal: AbortSignal; onStableText?: (text: string, segments: number) => void }): LiveTranscription | undefined
}

export interface LiveTranscription {
  pushAudio(samples: Float32Array): void
  seal(): void
  finish(params: TranscribeParams): Promise<TranscribeResult>
  dispose(): void
}

/** provider 配置。用于运行时选择与参数注入。 */
export interface ProviderConfig {
  kind: 'custom' | 'openai' | 'local' | 'siliconflow'
  baseUrl: string
  apiKey?: string
  /** Only used for the fixed SiliconFlow endpoint, never copied from apiKey. */
  siliconflowApiKey?: string
  /** OpenAI 的模型名，如 gpt-4o-transcribe */
  model?: string
  /** 是否启用润色环节（OpenAI 需额外一次 chat 调用） */
  refine?: boolean
  refineModel?: string
  /** Separate official text-only service; never reuse the ASR API key. */
  refinement?: RefinementConfig
  appVersion: string
  getToken?: () => Promise<string | null>
  getDeviceId?: () => string
}

/** 单条检索来源。 */
export interface GroundingChunk {
  index: number
  domain: string
  title: string
  uri: string
  iconUrl: string
}

/**
 * 联网检索结果。
 *
 * supports 标注哪段回答对应哪个来源——
 * 这是把「AI 说的」和「哪来的」对应起来的关键，缺了它引用列表只是装饰。
 */
export interface GroundingInfo {
  chunks: GroundingChunk[]
  supports: GroundingSupport[]
}

export interface GroundingSupport {
  /** 该论断在回答中的起止位置（字符偏移） */
  startIndex?: number
  endIndex?: number
  /** 对应 chunks 的索引 */
  chunkIndices: number[]
}

/**
 * 归一化服务端返回的 grounding 数据。
 *
 * 渲染层的 extractGrounding/normalizeChunks：
 * 服务端字段是嵌套的 {web: {domain, title, uri, icon_url}}，需拍平。
 */
export function normalizeGrounding(payload: unknown): GroundingInfo | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const raw = payload as Record<string, any>
  const chunksRaw = Array.isArray(raw.grounding_chunks) ? raw.grounding_chunks : []
  const supportsRaw = Array.isArray(raw.grounding_supports) ? raw.grounding_supports : []

  if (chunksRaw.length === 0) return undefined

  const chunks: GroundingChunk[] = chunksRaw.map((c: any, index: number) => ({
    index,
    domain: c?.web?.domain ?? '',
    title: c?.web?.title ?? '',
    uri: c?.web?.uri ?? '',
    iconUrl: c?.web?.icon_url ?? ''
  }))

  const supports: GroundingSupport[] = supportsRaw.map((s: any) => ({
    startIndex: typeof s?.start_index === 'number' ? s.start_index : undefined,
    endIndex: typeof s?.end_index === 'number' ? s.end_index : undefined,
    chunkIndices: Array.isArray(s?.chunk_indices) ? s.chunk_indices : []
  }))

  return { chunks, supports }
}
