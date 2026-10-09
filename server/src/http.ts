// HTTP 工具：multipart 解析、统一响应、请求体读取。
//
// 不引第三方框架：服务器上 npm 不可用，且需求简单——
// 一个路由表 + 手写 multipart 解析足够。这也让部署只需 scp 一个文件。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, detail: string) { super(detail); this.status = status }
}

const MAX_JSON_BODY = 8 * 1024 * 1024      // 8MB，足够 200 条记录的批量推送
const MAX_MULTIPART_BODY = 64 * 1024 * 1024 // 64MB，约 9 分钟 Opus 的 20 倍余量

export function readBody(req: IncomingMessage, limit = MAX_JSON_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        chunks.length = 0
        reject(new HttpError(413, 'payload_too_large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const authRequest = (req.url ?? '').startsWith('/oauth/')
  const body = await readBody(req, authRequest ? 16 * 1024 : MAX_JSON_BODY)
  if (body.length === 0) return {} as T
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch { throw new HttpError(400, 'invalid_json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json_object')
  if (authRequest) {
    const limits: Record<string, number> = { email:254, password:1024, new_password:1024,
      display_name:80, code:128, code_verifier:128, state:128, code_challenge:128, refresh_token:256, redirect_uri:512 }
    for (const [name, length] of Object.entries(limits)) {
      const field = (value as Record<string, unknown>)[name]
      if (field !== undefined && (typeof field !== 'string' || field.length > length)) throw new HttpError(400, 'invalid_auth_input')
    }
  }
  return value as T
}

export interface ParsedMultipart {
  file?: { data: Buffer; filename: string; contentType: string }
  fields: Record<string, string>
}

/**
 * 手写 multipart/form-data 解析。
 *
 * 边界处理的关键：按 boundary 切分，每个 part 的头部与体以空行分隔，
 * 体尾部要去掉 boundary 前的 CRLF。
 */
export function parseMultipart(body: Buffer, contentType: string): ParsedMultipart {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2]
  if (!boundary) throw new Error('no_boundary')

  const delimiter = Buffer.from(`--${boundary}`)
  const result: ParsedMultipart = { fields: {} }

  let pos = body.indexOf(delimiter)
  while (pos !== -1) {
    const partStart = pos + delimiter.length
    if (body.slice(partStart, partStart + 2).toString() === '--') break

    const headerEnd = body.indexOf('\r\n\r\n', partStart)
    if (headerEnd === -1) break
    const headers = body.slice(partStart, headerEnd).toString('utf8')

    const nextDelim = body.indexOf(delimiter, headerEnd)
    if (nextDelim === -1) break
    // 去掉数据尾部的 CRLF
    let dataEnd = nextDelim
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2
    const data = body.slice(headerEnd + 4, dataEnd)

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

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'private, no-store, max-age=0',
    'cdn-cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(payload)
}

/** HTML 响应。授权页需要它。 */
export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    // 授权页含表单与内联脚本，禁止缓存避免拿到过期的 challenge
    'cache-control': 'no-store'
  })
  res.end(html)
}

/** 302 重定向。授权成功后跳回客户端深链接。 */
export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

/**
 * 成功响应。形状：{ status: 'OK', data: {...} }
 * 客户端按 payload.status === 'OK' 判断，缺了它会被当成失败。
 */
export function sendOk(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { status: 'OK', data })
}

/** 错误响应。形状：{ status, detail, code }。 */
export function sendError(res: ServerResponse, httpStatus: number, detail: string, code?: number): void {
  sendJson(res, httpStatus, { status: 'ERROR', detail, code: code ?? httpStatus })
}

export function readMultipart(req: IncomingMessage): Promise<ParsedMultipart> {
  return readBody(req, MAX_MULTIPART_BODY).then((body) => {
    const ct = req.headers['content-type'] ?? ''
    if (!ct.includes('multipart/form-data')) throw new Error('expected_multipart')
    return parseMultipart(body, ct)
  })
}

/** Only the local reverse proxy may supply a validated client address. */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown'
  if (process.env.TRUST_PROXY === 'loopback' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
    const real = req.headers['x-real-ip']
    if (typeof real === 'string' && isIP(real)) return real
  }
  return peer
}

/** 简易内存限流。单进程部署够用；多实例需换 Redis。 */
const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt < now) {
    // Fail closed under a cardinality flood until the regular cleanup runs.
    if (!bucket && buckets.size >= 50_000) return false
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

/** 定期清理过期桶，避免内存无限增长。 */
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) {
    if (v.resetAt < now) buckets.delete(k)
  }
}, 60_000).unref()
