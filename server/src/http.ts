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
const parsedJson = new WeakMap<IncomingMessage, unknown>()

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
  if (parsedJson.has(req)) return parsedJson.get(req) as T
  const authRequest = (req.url ?? '').startsWith('/oauth/')
  const body = await readBody(req, authRequest ? 16 * 1024 : MAX_JSON_BODY)
  if (body.length === 0) { const empty = {}; parsedJson.set(req, empty); return empty as T }
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch { throw new HttpError(400, 'invalid_json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json_object')
  if (authRequest) {
    const limits: Record<string, number> = { email:254, password:1024, new_password:1024,
      display_name:80, code:128, code_verifier:128, state:128, code_challenge:128, refresh_token:256, redirect_uri:512, turnstile_token:2048 }
    for (const [name, length] of Object.entries(limits)) {
      const field = (value as Record<string, unknown>)[name]
      if (field !== undefined && (typeof field !== 'string' || field.length > length)) throw new HttpError(400, 'invalid_auth_input')
    }
  }
  parsedJson.set(req, value)
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

/**
 * Rate-limit identity for an address: IPv4 (and IPv4-mapped IPv6) as-is,
 * IPv6 truncated to its /64 — a single subscriber controls a whole /64, so
 * per-address buckets would let one host mint unlimited keys.
 */
export function rateLimitIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped && isIP(mapped[1]) === 4) return mapped[1]
  if (isIP(ip) !== 6) return ip
  const addr = ip.split('%')[0].toLowerCase()
  const [head, tail = ''] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = addr.includes('::') && tail ? tail.split(':') : []
  // An embedded IPv4 tail occupies the last 32 bits, never the /64 prefix.
  const tLen = t.length + (t.at(-1)?.includes('.') ? 1 : 0)
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - tLen)).fill('0'), ...t] : h
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

/**
 * 简易内存限流。单进程部署够用；多实例需换 Redis。
 *
 * Two pools. Network-keyed buckets (prefixes below) are evictable: under a
 * cardinality flood we drop expired ones, then the oldest, and fail open.
 * Every other key is identity-keyed (mail-*, voice:<user>, reset:…) and is
 * never evicted, so an IP flood cannot reset a victim's email/voice counters.
 */
const EVICTABLE_PREFIXES = ['auth:', 'register:', 'voice-ip:']
const ipBuckets = new Map<string, { count: number; resetAt: number }>()
const protectedBuckets = new Map<string, { count: number; resetAt: number }>()
const MAX_IP_BUCKETS = 50_000
const MAX_PROTECTED_BUCKETS = 100_000
const lastSweep = new WeakMap<Map<string, unknown>, number>()

function sweepExpired(map: Map<string, { resetAt: number }>, now: number): void {
  // At most once per second so a full map of live buckets stays O(1) amortized.
  if (now - (lastSweep.get(map) ?? 0) < 1000) return
  lastSweep.set(map, now)
  for (const [k, v] of map) if (v.resetAt < now) map.delete(k)
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const evictable = EVICTABLE_PREFIXES.some(p => key.startsWith(p))
  const buckets = evictable ? ipBuckets : protectedBuckets
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt < now) {
    if (!bucket && buckets.size >= (evictable ? MAX_IP_BUCKETS : MAX_PROTECTED_BUCKETS)) {
      sweepExpired(buckets, now)
      if (evictable) {
        // Oldest first (Map insertion order); fail open for network buckets.
        for (const k of buckets.keys()) {
          if (buckets.size < MAX_IP_BUCKETS) break
          buckets.delete(k)
        }
      } else if (buckets.size >= MAX_PROTECTED_BUCKETS) {
        // Identity counters must keep counting: refuse rather than forget one.
        return false
      }
    }
    // Re-insert so insertion order tracks the newest window.
    buckets.delete(key)
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
  for (const map of [ipBuckets, protectedBuckets]) {
    for (const [k, v] of map) {
      if (v.resetAt < now) map.delete(k)
    }
  }
}, 60_000).unref()
