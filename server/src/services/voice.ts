// 语音服务：转写 + 润色。
//
// 架构：本机 whisper.cpp 做转写，上游 LLM 做润色。
// 转写必须本地（隐私 + 成本），润色可外包（质量更高）。
//
// 上游 LLM 通过环境变量配置，兼容任何 OpenAI 协议端点。

import { serviceEndpoint } from './network-policy.ts'

const ASR_URL = process.env.ASR_URL ?? 'http://127.0.0.1:8080'
const LLM_URL = process.env.LLM_URL ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? ''
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const REFINE_ENABLED = process.env.ENABLE_REFINE !== 'false'

/** 本地模式 → 服务端模式映射。 */
const SERVER_MODE: Record<string, string> = {
  voice_transcript: 'transcript',
  voice_command: 'ask_anything',
  voice_translation: 'translation'
}

const REFINE_PROMPTS: Record<string, string> = {
  voice_transcript: [
    '你是一个听写润色助手。用户语音口述的内容会有同音字错误、口语赘词（嗯、那个、就是说）、',
    '以及断句混乱。请修正错别字、去掉口语赘词、补全标点，输出连贯的书面文字。',
    '严格保持原意，不添加用户没说过的内容，不改变语气正式程度。只输出润色后的文本。'
  ].join(''),
  voice_command: '你是文本编辑助手。根据语音指令修改选中文本，只输出修改后的文本。',
  voice_translation: '你是翻译助手。把内容翻译成目标语言，保持原意且自然地道。只输出译文。'
}

export interface VoiceFlowParams {
  mode: string
  audio: Buffer
  filename: string
  duration?: number
  audioContext?: Record<string, unknown>
  parameters?: Record<string, unknown>
  language?: string
}

export interface VoiceFlowResult {
  refine_text: string
  raw_text: string
  delivery?: string
  refine_failed?: boolean
}

/** 调 whisper.cpp 转写。 */
async function transcribe(params: VoiceFlowParams): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([params.audio as unknown as BlobPart]), params.filename)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (params.language) form.append('language', params.language)

  const res = await fetch(serviceEndpoint(ASR_URL, '/inference'), {
    redirect: 'error',
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180_000)
  })
  if (!res.ok) {
    throw new Error(`asr_http_${res.status}`)
  }
  const payload = await res.json() as { text?: string }
  return (payload.text ?? '').trim()
}

/** 调上游 LLM 润色。失败返回 null，由调用方降级。 */
async function refine(
  rawText: string,
  params: VoiceFlowParams
): Promise<string | null> {
  if (!LLM_URL || !REFINE_ENABLED) return null

  const system = REFINE_PROMPTS[params.mode] ?? REFINE_PROMPTS.voice_transcript
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: system }]

  const ctx = params.audioContext ?? {}
  const ctxLines: string[] = []
  if (ctx.app_name) ctxLines.push(`使用场景：${ctx.app_name}`)
  if (ctx.web_domain) ctxLines.push(`网页：${ctx.web_domain}`)
  if (ctx.input_context) {
    ctxLines.push(`输入框已有内容（参考语气与术语）：\n${String(ctx.input_context).slice(-800)}`)
  }
  if (ctxLines.length) messages.push({ role: 'system', content: ctxLines.join('\n') })

  const p = params.parameters ?? {}
  if (params.mode === 'voice_command' && p.selected_text) {
    messages.push({ role: 'user', content: `选中文本：\n${p.selected_text}\n\n指令：${rawText}` })
  } else if (params.mode === 'voice_translation') {
    const target = p.output_language ? `目标语言：${p.output_language}\n\n` : ''
    messages.push({ role: 'user', content: `${target}原文：${rawText}` })
  } else {
    messages.push({ role: 'user', content: rawText })
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (LLM_API_KEY) headers.authorization = `Bearer ${LLM_API_KEY}`

  try {
    const res = await fetch(serviceEndpoint(LLM_URL, '/v1/chat/completions'), {
      redirect: 'error',
      method: 'POST',
      headers,
      body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.2, max_tokens: 4096 }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) return null
    const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content.trim() : null
  } catch {
    return null
  }
}

/**
 * 完整语音流程：转写 → 润色。
 *
 * 返回结构与 /ai/voice_flow 约定一致：
 * refine_text 是润色稿，raw_text 是 ASR 原文。
 *
 * 转写来源有两种：
 * - 客户端上传音频 → 服务端调本机 whisper
 * - 客户端已本地转写 → 只把文本发来润色（text 字段）
 *
 * 后者是当前推荐架构：whisper 跑在用户本机（M 系列芯片快且音频不出本机），
 * 服务器只承担润色。这样 1 核服务器也能支撑多用户。
 */
export async function voiceFlow(params: VoiceFlowParams & { text?: string }): Promise<VoiceFlowResult> {
  // 客户端已本地转写：跳过 ASR，直接润色
  if (params.text !== undefined) {
    const raw = params.text.trim()
    if (!raw) return { refine_text: '', raw_text: '' }
    const refined = await refine(raw, params)
    if (refined === null) {
      return { refine_text: raw, raw_text: raw, refine_failed: params.mode !== 'voice_transcript' || (Boolean(LLM_URL) && REFINE_ENABLED) }
    }
    return { refine_text: refined, raw_text: raw }
  }

  const raw = await transcribe(params)
  if (!raw) return { refine_text: '', raw_text: '' }

  const refined = await refine(raw, params)
  if (refined === null) {
    // 润色不可用或失败：降级返回原文，标记以便客户端提示
    return {
      refine_text: raw,
      raw_text: raw,
      refine_failed: params.mode !== 'voice_transcript' || (Boolean(LLM_URL) && REFINE_ENABLED)
    }
  }

  return { refine_text: refined, raw_text: raw }
}

/** 单独暴露润色能力，供只有文本的调用方使用。 */
export async function refineText(
  text: string,
  mode: string,
  audioContext?: Record<string, unknown>,
  parameters?: Record<string, unknown>
): Promise<{ refine_text: string; raw_text: string; refine_failed: boolean }> {
  const refined = await refine(text, { mode, audioContext, parameters } as VoiceFlowParams)
  if (refined === null) {
    return { refine_text: text, raw_text: text, refine_failed: mode !== 'voice_transcript' || (Boolean(LLM_URL) && REFINE_ENABLED) }
  }
  return { refine_text: refined, raw_text: text, refine_failed: false }
}

/**
 * 健康检查：探测 ASR 与 LLM 可用性。
 *
 * ASR 的判定必须打 /inference 而非根路径——本机上 8080 曾被
 * librespeed 容器占用，根路径返回 200 但 /inference 是 404，
 * 只看状态码会得出「ASR 可用」的错误结论。
 * 用 OPTIONS/HEAD 探测该端点是否存在，比发真实音频廉价。
 */
export async function checkUpstreams(): Promise<{
  asr: boolean
  llm: boolean
  refine_enabled: boolean
}> {
  let asr = false
  let llm = false
  try {
    const res = await fetch(serviceEndpoint(ASR_URL, '/inference'), {
      redirect: 'error',
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    })
    // 400 表示端点存在但请求不合法（缺文件）—— 这正是我们要确认的
    // 404 表示端点不存在，说明该端口不是 whisper.cpp
    asr = res.status !== 404
  } catch { /* 不可用 */ }

  if (LLM_URL && REFINE_ENABLED) {
    try {
      const headers: Record<string, string> = {}
      if (LLM_API_KEY) headers.authorization = `Bearer ${LLM_API_KEY}`
      const res = await fetch(serviceEndpoint(LLM_URL, '/v1/models'), { headers, redirect: 'error', signal: AbortSignal.timeout(5000) })
      llm = res.ok
    } catch { /* 不可用 */ }
  }

  return { asr, llm, refine_enabled: REFINE_ENABLED }
}

export { SERVER_MODE }
