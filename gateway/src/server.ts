// OpenType 本地网关。
//
// 存在的理由：whisper.cpp 的 server 只提供 `/inference`（自有协议），
// 而客户端说的是 OpenAI 协议（`/v1/audio/transcriptions`）。
// 网关做三件事：
//
// 1. **协议适配** —— 把 OpenAI 形状的请求翻译成 whisper.cpp 的形状
// 2. **润色编排** —— OpenAI 只有裸转写，补一次 LLM 调用才能复现
//    「杂乱想法 → 清晰文字」的效果
// 3. **上下文注入** —— 客户端上传的 audio_context 编进润色 prompt
//
// 为什么值得独立成服务而不是塞进 Electron：
// 转写与润色都是计算密集任务，独立进程崩了不影响主应用；
// 且同一网关可服务多个客户端（桌面 + 移动 + 脚本）。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { serviceRequest as request } from '../../src/main/services/network'
import { serviceEndpoint } from '../../src/shared/network-policy'

// MARK: - 配置

interface GatewayConfig {
  port: number
  host: string
  /** whisper.cpp server 地址 */
  asrUrl: string
  /** LLM 服务地址（llama-server / ollama / OpenAI 兼容） */
  llmUrl: string
  llmModel: string
  /**
   * LLM 的 API Key。
   * 云端服务（如 api.rainflowtb.com）必需；本地 llama-server 留空即可。
   */
  llmApiKey: string
  /** 是否启用润色 */
  refine: boolean
  /** 无 LLM 时的降级行为：跳过润色直接返回原文 */
  refineFallbackToRaw: boolean
}

const config: GatewayConfig = {
  port: Number(process.env.GATEWAY_PORT ?? 8090),
  host: process.env.GATEWAY_HOST ?? '127.0.0.1',
  asrUrl: process.env.ASR_URL ?? 'http://127.0.0.1:8080',
  llmUrl: process.env.LLM_URL ?? 'http://127.0.0.1:8081',
  llmModel: process.env.LLM_MODEL ?? 'local',
  llmApiKey: process.env.LLM_API_KEY ?? '',
  refine: process.env.ENABLE_REFINE !== 'false',
  refineFallbackToRaw: process.env.REFINE_FALLBACK !== 'false'
}

// MARK: - 工具

/** 读取请求体到 Buffer。设上限防止超大上传打爆内存。 */
const MAX_BODY = 64 * 1024 * 1024   // 64MB，约 9 分钟 Opus 的 20 倍余量

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/**
 * 解析 multipart/form-data。
 *
 * 不引第三方库：只需要取出文件字节与几个文本字段，
 * 手写解析能避免为这点需求拉进一个依赖树。
 */
interface ParsedForm {
  file?: { data: Buffer; filename: string; contentType: string }
  fields: Record<string, string>
}

function parseMultipart(body: Buffer, contentType: string): ParsedForm {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2]
  if (!boundary) throw new Error('no_boundary')

  const delimiter = Buffer.from(`--${boundary}`)
  const result: ParsedForm = { fields: {} }

  let pos = body.indexOf(delimiter)
  while (pos !== -1) {
    const partStart = pos + delimiter.length
    // 结束标记是 "--"
    if (body.slice(partStart, partStart + 2).toString() === '--') break

    const headerEnd = body.indexOf('\r\n\r\n', partStart)
    if (headerEnd === -1) break
    const headers = body.slice(partStart, headerEnd).toString('utf8')

    const nextDelim = body.indexOf(delimiter, headerEnd)
    if (nextDelim === -1) break
    // 去掉尾部的 \r\n
    const dataEnd = body.slice(0, nextDelim).lastIndexOf('\r\n')
    const data = body.slice(headerEnd + 4, dataEnd === -1 ? nextDelim : dataEnd)

    const nameMatch = /name="([^"]+)"/i.exec(headers)
    const fileMatch = /filename="([^"]*)"/i.exec(headers)
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers)

    if (nameMatch) {
      if (fileMatch && fileMatch[1]) {
        result.file = {
          data,
          filename: fileMatch[1],
          contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream'
        }
      } else {
        result.fields[nameMatch[1]] = data.toString('utf8')
      }
    }

    pos = nextDelim
  }

  return result
}

// MARK: - ASR 转发

/**
 * 转发到 whisper.cpp 的 /inference。
 *
 * 字段名转换是这里的核心：OpenAI 用 `file`/`response_format`，
 * whisper.cpp 用 `file`/`response_format` 但端点不同且不认 `model`。
 * 多传未知字段 whisper.cpp 会忽略，所以只需保证必要字段到位。
 */
async function callAsr(
  audio: Buffer,
  filename: string,
  language?: string,
  signal?: AbortSignal
): Promise<{ text: string } | { error: string; status: number }> {
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart]), filename)
  form.append('response_format', 'json')
  // whisper.cpp 用 temperature=0 保证确定性输出
  form.append('temperature', '0')
  if (language) form.append('language', language)

  try {
    const res = await request(serviceEndpoint(config.asrUrl, '/inference'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])])
    })
    if (res.statusCode >= 400) {
      const detail = await res.body.text()
      return { error: `asr_http_${res.statusCode}: ${detail.slice(0, 200)}`, status: 502 }
    }
    const payload = await res.body.json() as { text?: string }
    return { text: (payload.text ?? '').trim() }
  } catch (err) {
    const msg = (err as Error).message
    const isDown = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
    return {
      error: isDown ? `asr_unavailable: whisper.cpp 未在 ${config.asrUrl} 运行` : msg,
      status: isDown ? 503 : 502
    }
  }
}

// MARK: - 润色

const REFINE_SYSTEM: Record<string, string> = {
  voice_transcript: [
    '你是一个听写润色助手。用户语音口述的内容会有同音字错误、口语赘词（嗯、那个、就是说）、',
    '以及断句混乱。请修正错别字、去掉口语赘词、补全标点，输出连贯的书面文字。',
    '严格保持原意，不添加用户没说过的内容，不改变语气正式程度。只输出润色后的文本。'
  ].join(''),
  voice_command: '你是文本编辑助手。根据语音指令修改选中文本，只输出修改后的文本。',
  voice_translation: '你是翻译助手。把内容翻译成目标语言，保持原意且自然地道。只输出译文。'
}

/**
 * 调用本地 LLM 润色。
 *
 * 兼容 llama-server 与 ollama：两者都提供 OpenAI 形状的 /v1/chat/completions。
 * 失败时返回 null，由调用方决定降级还是报错——润色失败不该让整条链路失败。
 */
async function callRefine(
  rawText: string,
  mode: string,
  context: Record<string, unknown>,
  parameters: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string | null> {
  const system = REFINE_SYSTEM[mode] ?? REFINE_SYSTEM.voice_transcript

  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: system }]

  // 上下文注入：只传对润色有用的字段
  const ctxLines: string[] = []
  if (context.app_name) ctxLines.push(`使用场景：${context.app_name}`)
  if (context.web_domain) ctxLines.push(`网页：${context.web_domain}`)
  if (context.input_context) {
    // 输入框已有内容最有价值：模型据此判断正式/口语风格与术语拼写
    ctxLines.push(`输入框已有内容（参考语气与术语）：\n${String(context.input_context).slice(-800)}`)
  }
  if (ctxLines.length) messages.push({ role: 'system', content: ctxLines.join('\n') })

  if (mode === 'voice_command' && parameters.selected_text) {
    messages.push({ role: 'user', content: `选中文本：\n${parameters.selected_text}\n\n指令：${rawText}` })
  } else if (mode === 'voice_translation') {
    const target = parameters.output_language ? `目标语言：${parameters.output_language}\n\n` : ''
    messages.push({ role: 'user', content: `${target}原文：${rawText}` })
  } else {
    messages.push({ role: 'user', content: rawText })
  }

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // 云端 LLM 需要认证；本地服务留空即可
    if (config.llmApiKey) headers.authorization = `Bearer ${config.llmApiKey}`

    const res = await request(serviceEndpoint(config.llmUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        temperature: 0.2,
        // 限输出长度：润色不该产生比原文长很多的文本，超长说明模型跑偏了
        max_tokens: 4096
      }),
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])])
    })
    if (res.statusCode >= 400) { await res.body.dump(); return null }
    const payload = await res.body.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content.trim() : null
  } catch {
    return null
  }
}

// MARK: - 路由

async function handleTranscriptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController()
  const onDisconnect = () => { if (!res.writableEnded) controller.abort() }
  res.once('close', onDisconnect)
  try {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) {
      json(res, 400, { error: { message: 'expected multipart/form-data', type: 'invalid_request_error' } })
      return
    }

    let form: ParsedForm
    try {
      form = parseMultipart(await readBody(req), contentType)
    } catch (err) {
      const msg = (err as Error).message
      json(res, msg === 'payload_too_large' ? 413 : 400, {
        error: { message: msg, type: 'invalid_request_error' }
      })
      return
    }

    if (!form.file) {
      json(res, 400, { error: { message: 'missing file field', type: 'invalid_request_error' } })
      return
    }

    // 语言：优先请求参数，其次上下文里的偏好
    const language = form.fields.language || undefined

    const asr = await callAsr(form.file.data, form.file.filename, language, controller.signal)
    controller.signal.throwIfAborted()
    if ('error' in asr) {
      json(res, asr.status, { error: { message: asr.error, type: 'upstream_error' } })
      return
    }
    if (!asr.text) {
      json(res, 200, { text: '' })
      return
    }

    // 润色。OpenType 客户端把模式与上下文放在自定义字段里（非 OpenAI 标准），
    // 网关识别到就编排润色，否则只做裸转写。
    let text = asr.text
    const mode = form.fields.mode ?? 'voice_transcript'
    if (!['voice_transcript', 'voice_translation', 'voice_command'].includes(mode)) {
      json(res, 400, { error: { message: 'invalid_mode', type: 'invalid_request_error' } })
      return
    }
    let refineFailed = false
    const shouldRefine = config.refine && form.fields.refine !== 'false'
    if (!shouldRefine && mode !== 'voice_transcript') {
      json(res, 503, { raw_text: asr.text, error: { message: 'refine_unavailable', type: 'upstream_error' } })
      return
    }
    if (shouldRefine) {
      let context: Record<string, unknown> = {}
      let parameters: Record<string, unknown> = {}
      try { context = JSON.parse(form.fields.audio_context ?? '{}') } catch { /* 忽略畸形上下文 */ }
      try { parameters = JSON.parse(form.fields.parameters ?? '{}') } catch { /* 同上 */ }

      const refined = await callRefine(asr.text, mode, context, parameters, controller.signal)
      controller.signal.throwIfAborted()
      if (refined) {
        text = refined
      } else if (!config.refineFallbackToRaw || mode !== 'voice_transcript') {
        json(res, 502, { raw_text: asr.text, error: { message: 'refine_failed', type: 'upstream_error' } })
        return
      } else refineFailed = true
    }

    // 返回 OpenAI 形状
    json(res, 200, { text, raw_text: asr.text, refine_failed: refineFailed })
  } finally { res.removeListener('close', onDisconnect) }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      asr: config.asrUrl,
      llm: config.refine ? config.llmUrl : null,
      refine: config.refine
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    void handleTranscriptions(req, res).catch((err) => {
      if (res.destroyed) return
      json(res, 500, { error: { message: (err as Error).message, type: 'internal_error' } })
    })
    return
  }

  json(res, 404, { error: { message: `unknown route: ${url.pathname}`, type: 'invalid_request_error' } })
})

server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port}`)
  console.log(`[gateway] ASR  → ${config.asrUrl}`)
  console.log(`[gateway] LLM  → ${config.refine ? `${config.llmUrl} (${config.llmModel})` : '(已禁用润色)'}`)
  if (config.refine && config.llmApiKey) console.log('[gateway] LLM 认证: 已配置 API Key')
})
