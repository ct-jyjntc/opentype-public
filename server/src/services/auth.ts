// 账号体系：注册、登录、PKCE 授权码、token 签发与轮换。
//
// 协议约定：
// - 响应统一为 { status: 'OK', data: {...} } 或 { status: 'ERROR', detail, code }
// - token 用 JWT 形状（header.payload.signature），但签名用 HS256 + 服务端密钥
// - 刷新时轮换 refresh_token，旧令牌立即作废
//
// 为什么用 HS256 而非 RS256：单服务部署，无需第三方验签，
// 对称密钥省去密钥分发的复杂度。多服务时应换 RS256。

import { randomUUID, randomBytes, randomInt, createHash, createHmac, timingSafeEqual, pbkdf2Sync } from 'node:crypto'
import { getDb, transaction } from '../db/index.ts'

const ACCESS_TOKEN_TTL_MS = 3600 * 1000          // 1 小时
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000  // 30 天
const AUTH_CODE_TTL_MS = 5 * 60 * 1000           // 5 分钟
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000         // 10 分钟
const PBKDF2_ROUNDS = 100_000                    // 远高于常见的 10000 轮
const PBKDF2_KEYLEN = 32

export interface User {
  user_id: string
  email: string
  display_name: string
}

export interface TokenPair {
  access_token: string
  refresh_token: string
  expires_in: number
  user_id: string
}

// MARK: - 密钥管理

/**
 * 签名密钥。从环境变量读取，未设置时生成并持久化到数据库——
 * 重启后 token 不失效，这对用户体验很重要（否则每次部署都要重新登录）。
 */
let signingKey: Buffer | null = null

export function initSigningKey(envKey?: string): void {
  if (envKey) {
    signingKey = createHash('sha256').update(envKey).digest()
    return
  }
  const db = getDb()
  const row = db.prepare('SELECT value FROM server_config WHERE key = ?').get('jwt_secret') as { value: string } | undefined
  if (row) {
    signingKey = Buffer.from(row.value, 'base64')
    return
  }
  const generated = randomBytes(32)
  db.prepare('INSERT INTO server_config (key, value, updated_at) VALUES (?, ?, ?)')
    .run('jwt_secret', generated.toString('base64'), Date.now())
  signingKey = generated
}

function key(): Buffer {
  if (!signingKey) throw new Error('signing key not initialized')
  return signingKey
}

// MARK: - JWT

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

function signToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', key()).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

export interface TokenClaims {
  sub: string
  email: string
  sid: string
  iat: number
  exp: number
}

/** 校验 access token。返回 null 表示无效或过期。 */
export function verifyAccessToken(token: string): TokenClaims | null {
  if (token.length > 8192) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = createHmac('sha256', key()).update(`${header}.${body}`).digest('base64url')

  // 定长比较防时序侧信道。长度不同时直接返回，避免 timingSafeEqual 抛错。
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()
      || typeof claims.sub !== 'string' || typeof claims.email !== 'string' || typeof claims.sid !== 'string') return null
    // A signed token alone must not resurrect a deleted account or a logged-out session.
    const session = getDb().prepare(`SELECT 1 FROM refresh_tokens r JOIN users u ON u.user_id = r.user_id
      WHERE r.session_id = ? AND r.user_id = ? AND r.revoked_at IS NULL AND r.expires_at > ?`).get(claims.sid, claims.sub, Date.now())
    if (!session) return null
    return claims
  } catch {
    return null
  }
}

// MARK: - 密码

/** PBKDF2 派生。格式：pbkdf2$<rounds>$<salt_b64>$<hash_b64> */
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, PBKDF2_ROUNDS, PBKDF2_KEYLEN, 'sha256')
  return `pbkdf2$${PBKDF2_ROUNDS}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const rounds = Number(parts[1])
  const salt = Buffer.from(parts[2], 'base64')
  const expected = Buffer.from(parts[3], 'base64')
  const actual = pbkdf2Sync(password, salt, rounds, expected.length, 'sha256')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// MARK: - 账号操作

export function registerUser(email: string, password: string, displayName?: string): User | { error: string } {
  if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 1024
    || (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 80))) return { error: 'invalid_auth_input' }
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { error: 'invalid_email' }
  if (password.length < 8) return { error: 'password_too_short' }

  const existing = db.prepare('SELECT user_id FROM users WHERE email = ?').get(normalized)
  if (existing) return { error: 'email_exists' }

  const now = Date.now()
  const userId = randomUUID()
  db.prepare(
    'INSERT INTO users (user_id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, normalized, hashPassword(password), displayName ?? normalized.split('@')[0], now, now)

  return { user_id: userId, email: normalized, display_name: displayName ?? normalized.split('@')[0] }
}

export function authenticate(email: string, password: string): User | null {
  if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 1024) return null
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  const row = db.prepare(
    'SELECT user_id, email, password_hash, display_name FROM users WHERE email = ?'
  ).get(normalized) as { user_id: string; email: string; password_hash: string | null; display_name: string } | undefined
  if (!row?.password_hash) return null
  if (!verifyPassword(password, row.password_hash)) return null
  return { user_id: row.user_id, email: row.email, display_name: row.display_name }
}

export function getUserById(userId: string): User | null {
  const db = getDb()
  const row = db.prepare('SELECT user_id, email, display_name FROM users WHERE user_id = ?').get(userId) as
    | { user_id: string; email: string; display_name: string } | undefined
  return row ?? null
}

export function getUserByEmail(email: string): User | null {
  const db = getDb()
  const row = db.prepare('SELECT user_id, email, display_name FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as { user_id: string; email: string; display_name: string } | undefined
  return row ?? null
}

/** 用邮箱创建或取回账号（邮箱验证码登录用）。 */
export function upsertUserByEmail(email: string): User {
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  const existing = db.prepare('SELECT user_id, email, display_name FROM users WHERE email = ?').get(normalized) as
    | { user_id: string; email: string; display_name: string } | undefined
  if (existing) return existing

  const now = Date.now()
  const userId = randomUUID()
  const displayName = normalized.split('@')[0]
  db.prepare(
    'INSERT INTO users (user_id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)'
  ).run(userId, normalized, displayName, now, now)
  return { user_id: userId, email: normalized, display_name: displayName }
}

// MARK: - token 签发

export function issueTokens(user: User, userAgent?: string): TokenPair {
  const db = getDb()
  const now = Date.now()
  const sessionId = randomUUID()

  const accessToken = signToken({
    sub: user.user_id,
    email: user.email,
    sid: sessionId,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ACCESS_TOKEN_TTL_MS) / 1000)
  })

  // refresh token 用随机串而非 JWT：它需要能被服务端主动作废，
  // 而 JWT 无状态特性恰恰让「立即作废」做不到
  const refreshToken = randomBytes(48).toString('base64url')
  db.prepare(
    'INSERT INTO refresh_tokens (token, user_id, issued_at, expires_at, user_agent, session_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(refreshToken, user.user_id, now, now + REFRESH_TOKEN_TTL_MS, userAgent?.slice(0,512) ?? null, sessionId)

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    user_id: user.user_id
  }
}

/**
 * 刷新 token 并轮换。
 *
 * 关键：旧 refresh_token 立即作废。若被泄露，攻击者用一次后
 * 合法用户下次刷新就会失败，从而暴露泄露事件。
 */
export function refreshTokens(refreshToken: string, userAgent?: string): TokenPair | null {
  const db = getDb()
  const now = Date.now()
  const row = db.prepare(
    'SELECT token, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token = ?'
  ).get(refreshToken) as { token: string; user_id: string; expires_at: number; revoked_at: number | null } | undefined

  if (!row) return null
  if (row.revoked_at !== null) {
    // 已作废的令牌被再次使用 → 视为泄露，吊销该用户全部令牌
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, row.user_id)
    return null
  }
  if (row.expires_at < now) return null

  const user = getUserById(row.user_id)
  if (!user) return null

  return transaction(() => {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token = ?').run(now, refreshToken)
    return issueTokens(user, userAgent)
  })
}

export function revokeRefreshToken(refreshToken: string): boolean {
  const db = getDb()
  const result = db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
    .run(Date.now(), refreshToken)
  return Number(result.changes) > 0
}

export function revokeAllUserTokens(userId: string): void {
  getDb().prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId)
}

// MARK: - PKCE 授权码

/** 生成授权码。code_challenge 由客户端提供（PKCE 的 S256）。 */
export function createAuthCode(
  userId: string,
  codeChallenge: string,
  state: string,
  redirectUri?: string
): string {
  const db = getDb()
  const code = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare(
    'INSERT INTO auth_codes (code, user_id, code_challenge, state, redirect_uri, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(code, userId, codeChallenge, state, redirectUri ?? null, now, now + AUTH_CODE_TTL_MS)
  return code
}

/**
 * 兑换授权码，校验 PKCE。
 *
 * 校验 code_verifier 的 SHA-256 是否等于注册时的 code_challenge——
 * 这证明兑换请求来自发起授权的同一客户端。
 * 授权码一次性使用：兑换后立即标记 consumed，防止重放。
 */
export function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  state: string
): TokenPair | { error: string } {
  const db = getDb()
  const now = Date.now()
  const row = db.prepare(
    'SELECT code, user_id, code_challenge, state, expires_at, consumed_at FROM auth_codes WHERE code = ?'
  ).get(code) as {
    code: string; user_id: string; code_challenge: string; state: string
    expires_at: number; consumed_at: number | null
  } | undefined

  if (!row) return { error: 'invalid_code' }
  if (row.consumed_at !== null) return { error: 'code_already_used' }
  if (row.expires_at < now) return { error: 'code_expired' }
  if (row.state !== state) return { error: 'state_mismatch' }

  // PKCE S256：challenge = base64url(sha256(verifier))
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  if (computed !== row.code_challenge) return { error: 'pkce_verification_failed' }

  const user = getUserById(row.user_id)
  if (!user) return { error: 'user_not_found' }

  return transaction(() => {
    db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE code = ?').run(now, code)
    return issueTokens(user)
  })
}

// MARK: - 邮箱验证码

export function createEmailCode(email: string): string {
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  // 6 位数字。用 randomInt 而非 Math.random——后者可预测。
  const code = String(randomInt(100000, 1000000))
  const now = Date.now()
  db.prepare(
    'INSERT OR REPLACE INTO email_codes (email, code, issued_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, ?, 0, NULL)'
  ).run(normalized, code, now, now + EMAIL_CODE_TTL_MS)
  return code
}

export function verifyEmailCode(email: string, code: string): User | { error: string } {
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  const row = db.prepare(
    'SELECT email, code, expires_at, attempts, consumed_at FROM email_codes WHERE email = ?'
  ).get(normalized) as { email: string; code: string; expires_at: number; attempts: number; consumed_at: number | null } | undefined

  if (!row) return { error: 'no_code_issued' }
  if (row.consumed_at !== null) return { error: 'code_already_used' }
  if (row.expires_at < Date.now()) return { error: 'code_expired' }
  // 限次防暴力破解：6 位码只有 90 万种可能
  if (row.attempts >= 5) return { error: 'too_many_attempts' }

  if (row.code !== code) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(normalized)
    return { error: 'invalid_code' }
  }

  db.prepare('UPDATE email_codes SET consumed_at = ? WHERE email = ?').run(Date.now(), normalized)
  return upsertUserByEmail(normalized)
}

// MARK: - 密码重置验证码

const RESET_CODE_TTL_MS = 10 * 60 * 1000

/**
 * 为已存在的账号签发重置码。调用方负责确认邮箱已注册——
 * 未注册时不应走到这里（防账号枚举由路由层统一响应兜底）。
 */
export function createPasswordResetCode(email: string): string {
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  const code = String(randomInt(100000, 1000000))
  const now = Date.now()
  db.prepare(
    'INSERT OR REPLACE INTO password_reset_codes (email, code, issued_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, ?, 0, NULL)'
  ).run(normalized, code, now, now + RESET_CODE_TTL_MS)
  return code
}

/**
 * 校验重置码并重置密码。
 *
 * 与 verifyEmailCode 的关键区别：不 upsert 建号——
 * 重置场景的用户必须已存在，验证码只是身份证明。
 * 成功后吊销全部 refresh token，让旧会话立即失效。
 */
export function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): { ok: true } | { error: string } {
  if (typeof email !== 'string' || email.length > 254 || typeof code !== 'string' || !/^\d{6}$/.test(code)
    || typeof newPassword !== 'string' || newPassword.length > 1024) return { error: 'invalid_auth_input' }
  const db = getDb()
  const normalized = email.trim().toLowerCase()
  if (newPassword.length < 8) return { error: 'password_too_short' }

  const row = db.prepare(
    'SELECT email, code, expires_at, attempts, consumed_at FROM password_reset_codes WHERE email = ?'
  ).get(normalized) as { email: string; code: string; expires_at: number; attempts: number; consumed_at: number | null } | undefined

  if (!row) return { error: 'no_code_issued' }
  if (row.consumed_at !== null) return { error: 'code_already_used' }
  if (row.expires_at < Date.now()) return { error: 'code_expired' }
  if (row.attempts >= 5) return { error: 'too_many_attempts' }

  if (row.code !== code) {
    db.prepare('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE email = ?').run(normalized)
    return { error: 'invalid_code' }
  }

  const user = getUserByEmail(normalized)
  if (!user) return { error: 'user_not_found' }

  transaction(() => {
    db.prepare('UPDATE password_reset_codes SET consumed_at = ? WHERE email = ?').run(Date.now(), normalized)
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?')
      .run(hashPassword(newPassword), Date.now(), user.user_id)
    revokeAllUserTokens(user.user_id)
  })
  return { ok: true }
}

// MARK: - 账号删除

/**
 * 删除账号及全部关联数据。
 *
 * refresh_tokens / auth_codes / sync_settings / dictionary_words /
 * user_settings 走外键级联；history 无外键（同步语义要求字段稳定），
 * email_codes / password_reset_codes 按 email 键，都需手工清理。
 * 先吊销 token 再删行，保证删除中途失败的窗口里旧会话也无法续期。
 */
export function deleteUserAccount(userId: string): boolean {
  const db = getDb()
  const user = getUserById(userId)
  if (!user) return false
  revokeAllUserTokens(userId)
  transaction(() => {
    db.prepare('DELETE FROM history WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(user.email)
    db.prepare('DELETE FROM password_reset_codes WHERE email = ?').run(user.email)
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId)
  })
  return true
}
