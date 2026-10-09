// OpenType 后端服务。
//
// 服务端协议实现，与客户端既有调用约定保持一致。
//
// 端点分组：
//   /oauth/*                 账号与令牌（含密码重置）
//   /transcription_history/* 历史同步
//   /ai/voice_flow           语音转写+润色
//   /user/get_user_info      用户信息（含 RSA 公钥、角色、设置）
//   /user/dictionary/*       个人词典
//   /user/usage_stats 等     首页统计与设置（空态/持久化）
//   /app/get_blacklist_domain 域名黑名单
//
// 部署：单文件，零依赖，scp 上去 + systemd 即可。

import { createServer } from 'node:http'
import { initDb, closeDb } from './db/index.ts'
import { createHash } from 'node:crypto'
import {
  initSigningKey, registerUser, authenticate, getUserById, getUserByEmail, issueTokens, refreshTokens,
  revokeRefreshToken, createEmailCode, verifyEmailCode,
  createPasswordResetCode, resetPasswordWithCode, deleteUserAccount,
  verifyAccessToken
} from './services/auth.ts'
import {
  pushHistory, pullHistory, loadOlder, getSyncStatus, updateSyncSettings,
  wipeHistory, acknowledgeHints, getDomainBlacklist, isSyncEnabled, deleteHistory, cloudEpoch, expireCloudHistory
} from './services/history.ts'
import { voiceFlow } from './services/voice.ts'
import { sendCodeMail, mailConfigured, developmentEmailCodesAllowed } from './services/mail.ts'
import { getUserSettings, mergeUserSettings, getPath } from './services/settings.ts'
import {
  listWords, addWord, updateWord, deleteWord, batchDeleteWords, previewBulkImport, bulkImport
} from './services/dictionary.ts'
import {
  readJson, readMultipart, sendOk, sendError, sendJson,
  clientIp, rateLimit, HttpError
} from './http.ts'
import { challengeConfiguration, challengeRequired, validateChallengeConfiguration, verifyChallenge, type ChallengeAction } from './services/turnstile.ts'
import { getUsageStats, getInsights } from './services/stats.ts'
import { dictionaryStatus, pullDictionary, pushDictionary } from './services/dictionary-sync.ts'

const PORT = Number(process.env.PORT ?? 9100)
const HOST = process.env.HOST ?? '127.0.0.1'
const DB_PATH = process.env.DB_PATH ?? '/var/lib/opentype/opentype.db'
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('invalid_server_port')
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /^(change|replace|example)/i.test(process.env.JWT_SECRET)) {
    throw new Error('production_requires_strong_JWT_SECRET')
  }
  if (process.env.ALLOW_DEV_EMAIL_CODES === 'true') throw new Error('development_email_codes_forbidden_in_production')
}
validateChallengeConfiguration()
process.umask(0o077)

// MARK: - 初始化

initDb({ path: DB_PATH })
initSigningKey(process.env.JWT_SECRET)

// MARK: - 鉴权中间件

interface AuthResult {
  userId: string
  email: string
}

/**
 * 从 Authorization 头解析用户。
 *
 * 跳过列表里的端点不校验——尤其是刷新接口：
 * 过期 token 会让刷新本身失败，导致无法自愈。
 */
const AUTH_SKIP = new Set([
  '/oauth/refresh_access_token',
  '/oauth/signin_with_email',
  '/oauth/signin_with_google',
  '/oauth/auth_user_from_google',
  '/oauth/verify_secret_code',
  '/oauth/register',
  '/oauth/login',
  '/oauth/logout',
  '/oauth/request_password_reset',
  '/oauth/reset_password',
  '/app/get_blacklist_domain',
  '/health',
  '/oauth/challenge/config'
])

function authenticateRequest(path: string, req: import('node:http').IncomingMessage): AuthResult | null {
  if (AUTH_SKIP.has(path)) return { userId: '', email: '' }
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const claims = verifyAccessToken(header.slice(7))
  if (!claims) return null
  return { userId: claims.sub, email: claims.email }
}

// MARK: - 路由

type Handler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  auth: AuthResult
) => Promise<void> | void

function validatedEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) {
    throw new HttpError(400, 'invalid_email')
  }
  return value.trim().toLowerCase()
}

function reserveEmailDelivery(email: string): void {
  const identity = createHash('sha256').update(email).digest('hex')
  if (!rateLimit(`mail-minute:${identity}`, 1, 60_000) || !rateLimit(`mail-hour:${identity}`, 5, 3600_000)) {
    throw new HttpError(429, 'rate_limited')
  }
  if (!mailConfigured() && !developmentEmailCodesAllowed()) throw new HttpError(503, 'mail_not_configured')
}

async function deliverCode(email: string, code: string, purpose: 'login' | 'password_reset'): Promise<string | undefined> {
  if (await sendCodeMail(email, code, purpose)) return undefined
  if (developmentEmailCodesAllowed()) return code
  throw new HttpError(503, 'mail_delivery_failed')
}

const routes: Record<string, Handler> = {
  'GET /oauth/challenge/config': (_req, res) => sendOk(res, challengeConfiguration()),

  // ===== 健康检查 =====
  'GET /health': async (_req, res) => {
    sendJson(res, 200, { status: 'ok',
      service: 'opentype',
      account_api: 1
    })
  },

  // ===== 账号 =====
  /**
   * 邮箱登录第一步：发送验证码。
   *
   * 此端点只负责下发验证码，
   * 校验在 /oauth/verify_secret_code。
   * 若请求体带 password 则走密码认证（兼容旧客户端），
   * 否则发验证码。
   */
  'POST /oauth/signin_with_email': async (req, res) => {
    const body = await readJson<{ email: string; password?: string }>(req)
    const email = validatedEmail(body.email)

    // 带密码 → 密码认证路径
    if (body.password) {
      const user = authenticate(email, body.password)
      if (!user) return sendError(res, 401, 'invalid_credentials', 401)
      const tokens = issueTokens(user, req.headers['user-agent'])
      sendOk(res, { ...tokens, user: { user_id: user.user_id, email: user.email, display_name: user.display_name } })
      return
    }

    // 不带密码 → 发验证码
    reserveEmailDelivery(email)
    const code = createEmailCode(email)
    const devCode = await deliverCode(email, code, 'login')
    sendOk(res, {
      requires_verification: true,
      email,
      ...(devCode ? { dev_code: devCode } : {})
    })
  },

  /**
   * Google 登录。无 OAuth 凭据时降级为邮箱验证码——
   * 客户端调用同一端点，拿到 requires_verification 后走验证码流程。
   */
  'POST /oauth/signin_with_google': async (req, res) => {
    const body = await readJson<{ email?: string }>(req)
    const email = validatedEmail(body.email)
    reserveEmailDelivery(email)
    const code = createEmailCode(email)
    const devCode = await deliverCode(email, code, 'login')
    sendOk(res, { requires_verification: true, email, ...(devCode ? { dev_code: devCode } : {}) })
  },

  'POST /oauth/verify_secret_code': async (req, res) => {
    const body = await readJson<{ email: string; code: string }>(req)
    const result = verifyEmailCode(body.email ?? '', body.code ?? '')
    if ('error' in result) return sendError(res, 401, result.error, 401)
    const tokens = issueTokens(result, req.headers['user-agent'])
    sendOk(res, { ...tokens, user: { user_id: result.user_id, email: result.email, display_name: result.display_name } })
  },

  /**
   * 注册（邮箱 + 密码）。
   *
   * 与验证码流程并存：有邮件服务时用验证码，自建部署时用密码更实际。
   */
  'POST /oauth/register': async (req, res) => {
    const body = await readJson<{ email: string; password: string; display_name?: string }>(req)
    const result = registerUser(body.email ?? '', body.password ?? '', body.display_name)
    if ('error' in result) {
      const code = result.error === 'email_exists' ? 409 : 400
      return sendError(res, code, result.error, code)
    }
    const tokens = issueTokens(result, req.headers['user-agent'])
    sendOk(res, { ...tokens, user: { user_id: result.user_id, email: result.email, display_name: result.display_name } })
  },

  /**
   * 密码登录。
   *
   * 与 /oauth/signin_with_email 的区别：那个端点带 password 时也走这条路径，
   * 但语义上独立更清晰。客户端可任选。
   */
  'POST /oauth/login': async (req, res) => {
    const body = await readJson<{ email: string; password: string }>(req)
    const user = authenticate(body.email ?? '', body.password ?? '')
    if (!user) return sendError(res, 401, 'invalid_credentials', 401)
    const tokens = issueTokens(user, req.headers['user-agent'])
    sendOk(res, { ...tokens, user: { user_id: user.user_id, email: user.email, display_name: user.display_name } })
  },

  /**
   * 刷新令牌。不校验 Authorization——过期 token 会让刷新也失败。
   * 轮换 refresh_token，旧令牌立即作废。
   */
  'POST /oauth/refresh_access_token': async (req, res) => {
    const body = await readJson<{ refresh_token: string }>(req)
    if (!body.refresh_token) return sendError(res, 400, 'refresh_token_required', 400)
    const tokens = refreshTokens(body.refresh_token, req.headers['user-agent'])
    if (!tokens) return sendError(res, 401, 'invalid_refresh_token', 401)
    sendOk(res, tokens)
  },

  'POST /oauth/logout': async (req, res) => {
    const body = await readJson<{ refresh_token?: string }>(req)
    if (body.refresh_token) revokeRefreshToken(body.refresh_token)
    sendOk(res, { success: true })
  },

  /**
   * 请求密码重置码。
   *
   * 无论邮箱是否注册都返回相同响应——否则此端点就成了账号枚举器。
   * 未注册时不生成码、不发邮件，仅返回 OK。
   * dev_code 仅在「邮件未真正投递且非生产环境」时返回；
   * 它只在邮箱已注册时存在，所以生产环境绝不能带它。
   */
  'POST /oauth/request_password_reset': async (req, res) => {
    if (!rateLimit(`reset:${clientIp(req)}`, 5, 3600_000)) {
      return sendError(res, 429, 'rate_limited', 429)
    }
    const body = await readJson<{ email: string }>(req)
    const email = validatedEmail(body.email)
    reserveEmailDelivery(email)

    let devCode: string | undefined
    if (email && getUserByEmail(email)) {
      const code = createPasswordResetCode(email)
      devCode = await deliverCode(email, code, 'password_reset')
    }
    sendOk(res, { success: true, ...(devCode ? { dev_code: devCode } : {}) })
  },

  /** 校验重置码并重置密码。成功后吊销全部旧会话。 */
  'POST /oauth/reset_password': async (req, res) => {
    const body = await readJson<{ email: string; code: string; new_password: string }>(req)
    if (!body.email || !body.code || !body.new_password) {
      return sendError(res, 400, 'email_code_and_new_password_required', 400)
    }
    const result = resetPasswordWithCode(body.email, body.code, body.new_password)
    if ('error' in result) {
      const httpStatus = result.error === 'password_too_short' ? 400 : 401
      return sendError(res, httpStatus, result.error, httpStatus)
    }
    sendOk(res, { success: true })
  },

  'POST /oauth/auth_user_from_google': async (req, res) => {
    const body = await readJson<{ email: string }>(req)
    const email = validatedEmail(body.email)
    reserveEmailDelivery(email)
    const code = createEmailCode(email)
    const devCode = await deliverCode(email, code, 'login')
    sendOk(res, { requires_verification: true, email, ...(devCode ? { dev_code: devCode } : {}) })
  },

  // ===== 用户 =====
  /**
   * 用户信息。渲染层首页直接依赖此响应：
   * - roles.filter(...)（缺 roles 会抛错，首页永不渲染）
   * - is_new_user 决定走引导页还是主界面
   * - translation_settings.target_languages / locale 用于设置同步
   * - org_settings.retention_policy / subscription_type / org_id 用于企业策略合并
   */
  'GET /user/get_user_info': async (_req, res, auth) => {
    const user = getUserById(auth.userId)
    if (!user) return sendError(res, 401, 'unauthorized', 401)
    const settings = getUserSettings(user.user_id)
    const translationSettings = getPath(settings, 'translation_settings')
    sendOk(res, {
      user_id: user.user_id,
      email: user.email,
      display_name: user.display_name,
      // 客户端据此判断是否启用上下文加密。
      // 留空表示不加密——本地部署下 TLS 已足够，且
      // 上游实现使用全零 IV，安全性存疑，此处不沿用。
      rsa_public_key: '',
      // 全部功能免费：人人发永不过期的 pro 角色，客户端据此隐藏
      // 升级卡片/配额限制并跳过 onboarding 的付费墙步骤。
      // exp_time 用毫秒时间戳（客户端 dayjs 直接解析）。
      roles: [{ name: 'pro', exp_time: 4102444800000 }],
      is_new_user: false,
      locale: getPath(settings, 'user_info.locale') ?? null,
      translation_settings: (translationSettings && typeof translationSettings === 'object')
        ? translationSettings
        : { target_languages: [] },
      // 非企业部署：客户端的 ENTERPRISE 分支不会触发
      subscription_type: 'FREE',
      // 年付 Pro 标记：客户端对 PRO_YEARLY 隐藏「节省 60%」等续费促销卡片
      subscription_plan_name: 'PRO_YEARLY',
      org_id: null,
      org_settings: null
    })
  },

  'POST /user/update_onboarding': async (_req, res) => {
    sendOk(res, { success: true })
  },

  /**
   * 设置写入。渲染层发扁平点路径键值
   * （translation_settings.target_languages、user_info.locale、
   * personal_auto_style_on），按路径合并进用户设置 JSON。
   */
  'POST /user/update_settings': async (req, res, auth) => {
    const body = await readJson<Record<string, unknown>>(req)
    mergeUserSettings(auth.userId, body)
    sendOk(res, { success: true })
  },

  'GET /user/get_dictation_settings': async (_req, res, auth) => {
    const settings = getUserSettings(auth.userId)
    const dictation = getPath(settings, 'dictation_settings')
    const outputLanguageMap = (dictation && typeof dictation === 'object')
      ? (dictation as Record<string, unknown>).output_language_map
      : undefined
    sendOk(res, {
      dictation_settings: {
        output_language_map: (outputLanguageMap && typeof outputLanguageMap === 'object') ? outputLanguageMap : {}
      }
    })
  },

  'POST /user/set_dictation_settings': async (req, res, auth) => {
    const body = await readJson<{ output_language_map?: unknown }>(req)
    const map = (body.output_language_map && typeof body.output_language_map === 'object')
      ? body.output_language_map
      : {}
    mergeUserSettings(auth.userId, { 'dictation_settings.output_language_map': map })
    sendOk(res, { dictation_settings: { output_language_map: map } })
  },

  // ===== 词典 =====
  'POST /user/dictionary/sync/status': async (_req,res,auth) => sendOk(res,dictionaryStatus(auth.userId)),
  'POST /user/dictionary/sync/pull': async (req,res,auth) => {
    const body=await readJson<{cursor?:unknown;limit?:unknown}>(req)
    try { sendOk(res,pullDictionary(auth.userId,body.cursor??0,body.limit)) }
    catch(error){sendError(res,400,(error as Error).message,400)}
  },
  'POST /user/dictionary/sync/push': async (req,res,auth) => {
    const body=await readJson<{mutations?:unknown}>(req)
    try { sendOk(res,pushDictionary(auth.userId,body.mutations)) }
    catch(error){sendError(res,400,(error as Error).message,400)}
  },
  'GET /user/dictionary/list': async (req, res, auth) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
    const size = Math.min(500, Math.max(1, Number(url.searchParams.get('size') ?? 150) || 150))
    const query = url.searchParams.get('query') ?? undefined
    const autoParam = url.searchParams.get('auto')
    const auto = autoParam === null ? undefined : autoParam === 'true' || autoParam === '1'
    sendOk(res, listWords(auth.userId, { offset, size, query, auto }))
  },

  'POST /user/dictionary/add': async (req, res, auth) => {
    const body = await readJson<{ term?: unknown }>(req)
    const result = addWord(auth.userId, body.term)
    if ('error' in result) {
      const status = result.error === 'word_exists' ? 409 : 400
      return sendError(res, status, result.error, status)
    }
    sendOk(res, result)
  },

  'POST /user/dictionary/update': async (req, res, auth) => {
    const body = await readJson<{ user_dictionary_id?: unknown; term?: unknown }>(req)
    const result = updateWord(auth.userId, body.user_dictionary_id, body.term)
    if ('error' in result) {
      const status = result.error === 'word_not_found' ? 404 : result.error === 'word_exists' ? 409 : 400
      return sendError(res, status, result.error, status)
    }
    sendOk(res, result)
  },

  'POST /user/dictionary/delete': async (req, res, auth) => {
    const body = await readJson<{ user_dictionary_id?: unknown }>(req)
    const result = deleteWord(auth.userId, body.user_dictionary_id)
    if ('error' in result) return sendError(res, 400, result.error, 400)
    sendOk(res, result)
  },

  'POST /user/dictionary/batch-delete': async (req, res, auth) => {
    const body = await readJson<{ user_dictionary_ids?: unknown }>(req)
    const result = batchDeleteWords(auth.userId, body.user_dictionary_ids)
    if ('error' in result) return sendError(res, 400, result.error, 400)
    sendOk(res, result)
  },

  'POST /user/dictionary/bulk-import/preview': async (req, res, auth) => {
    const body = await readJson<{ content?: unknown }>(req)
    const result = previewBulkImport(auth.userId, body.content)
    if ('error' in result) return sendError(res, 400, result.error, result.code ?? 400)
    sendOk(res, result)
  },

  'POST /user/dictionary/bulk-import': async (req, res, auth) => {
    const body = await readJson<{ content?: unknown }>(req)
    const result = bulkImport(auth.userId, body.content)
    if ('error' in result) return sendError(res, 400, result.error, result.code ?? 400)
    sendOk(res, result)
  },

  // ===== 应用配置 =====
  'POST /app/get_blacklist_domain': async (_req, res) => {
    sendOk(res, { data: getDomainBlacklist() })
  },

  // ===== 首页统计（真实计算，见 services/stats.ts 的形状契约） =====
  'POST /user/usage_stats': async (_req, res, auth) => {
    if (!auth.userId) return sendError(res, 401, 'unauthorized', 401)
    sendOk(res, getUsageStats(auth.userId))
  },

  // data.{enabled,total_learning_ratio,category_stats}；enabled 跟随用户设置里的
  // personal_auto_style_on，这样设置页开关有真实效果
  'POST /user/personal_stats': async (_req, res, auth) => {
    const settings = getUserSettings(auth.userId)
    sendOk(res, {
      enabled: Boolean(settings.personal_auto_style_on),
      total_learning_ratio: 0,
      category_stats: []
    })
  },

  // data.{summary,heatmap}；summary 缺了分享页会白屏（读 active_days 抛 TypeError）
  'POST /user/insights': async (_req, res, auth) => {
    if (!auth.userId) return sendError(res, 401, 'unauthorized', 401)
    sendOk(res, getInsights(auth.userId))
  },

  // data.{banner_enabled,title,button}；自建部署没有配额营销横幅
  'POST /app/get_free_quota_notice_banner_config': async (_req, res) => {
    sendOk(res, { banner_enabled: false })
  },

  // data.invitation_codes（数组，客户端按 code 排序）
  'GET /user/get_invitation_codes': async (_req, res) => {
    sendOk(res, { invitation_codes: [] })
  },

  // data.{cards,total,current_page,current_page_size}
  'POST /gift_card/my_cards': async (req, res) => {
    const body = await readJson<{ page?: number; page_size?: number }>(req)
    sendOk(res, {
      cards: [],
      total: 0,
      current_page: Number(body.page ?? 1),
      current_page_size: Number(body.page_size ?? 20)
    })
  },

  // 非企业部署没有组织；data=null 时客户端按「无组织」处理
  'POST /organization/get_info': async (_req, res) => {
    sendOk(res, null)
  },

  // ===== 反馈与诊断 =====
  // 渲染层发 multipart：data 字段为 JSON 字符串，可选 audio 附件。
  // 自建部署只记录日志，不外发。body 只能读一次，所以先读原始字节再按
  // content-type 分流——multipart 之外的畸形请求也不该 500。
  'POST /user/feedback': async (req, res, auth) => {
    const body = await readBody(req, 64 * 1024 * 1024)
    const ct = req.headers['content-type'] ?? ''
    if (ct.includes('multipart/form-data')) {
      try {
        const form = parseMultipart(body, ct)
        let summary = '(no data field)'
        try {
          const data = JSON.parse(form.fields.data ?? '{}') as Record<string, unknown>
          summary = `keys=${Object.keys(data).join(',')}`
        } catch { /* data 字段畸形也只记录 */ }
        console.log(`[feedback] user=${auth.userId} ${summary} audio=${form.file ? form.file.data.length : 0}B`)
      } catch (err) {
        console.log(`[feedback] user=${auth.userId} 解析失败: ${(err as Error).message}`)
      }
    } else {
      console.log(`[feedback] user=${auth.userId} bytes=${body.length}`)
    }
    sendOk(res, { success: true })
  },

  'POST /user/diagnostics_report': async (req, res, auth) => {
    const body = await readJson<Record<string, unknown>>(req)
    console.log(`[diagnostics] user=${auth.userId} keys=${Object.keys(body).join(',')}`)
    sendOk(res, { success: true })
  },

  // ===== 账号注销 =====
  // 真删除：users 行 + 级联（tokens/auth_codes/sync_settings/dictionary_words/
  // user_settings）+ 手工清理 history 与按 email 键的验证码表。
  'POST /user/delete_account': async (req, res, auth) => {
    const body = await readJson<{ reason?: string }>(req).catch(() => ({} as { reason?: string }))
    console.log(`[account] 删除账号 user=${auth.userId} reason=${body.reason ?? '(未提供)'}`)
    if (!deleteUserAccount(auth.userId)) return sendError(res, 404, 'user_not_found', 404)
    sendOk(res, { success: true })
  },

  // ===== 历史同步 =====
  'POST /transcription_history/delete': async (req, res, auth) => {
    const body = await readJson<{ ids?: unknown }>(req)
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200 ||
      body.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) {
      return sendError(res, 400, 'invalid_deletion_ids', 400)
    }
    if (!isSyncEnabled(auth.userId)) return sendError(res, 403, 'sync_disabled', 403)
    sendOk(res, deleteHistory(auth.userId, body.ids))
  },
  'POST /transcription_history/push': async (req, res, auth) => {
    const body = await readJson<{ records: unknown[]; cloud_epoch?: number }>(req)
    if (!Array.isArray(body.records)) return sendError(res, 400, 'records_required', 400)
    if (!isSyncEnabled(auth.userId)) return sendError(res, 403, 'sync_disabled', 403)
    if ((body.cloud_epoch ?? 0) !== cloudEpoch(auth.userId)) return sendError(res, 409, 'cloud_epoch_changed', 409)
    const result = pushHistory(auth.userId, body.records as never, body.cloud_epoch)
    sendOk(res, result)
  },

  'POST /transcription_history/pull': async (req, res, auth) => {
    const body = await readJson<{ since?: number; limit?: number }>(req)
    const result = pullHistory(auth.userId, Number(body.since ?? 0), Number(body.limit ?? 50))
    sendOk(res, result)
  },

  'POST /transcription_history/load_older': async (req, res, auth) => {
    const body = await readJson<{ before?: number | null; limit?: number }>(req)
    const status = getSyncStatus(auth.userId)
    const result = loadOlder(
      auth.userId,
      body.before ?? null,
      Number(body.limit ?? 50),
      status.purge_before_at ?? undefined
    )
    sendOk(res, result)
  },

  'POST /transcription_history/sync_status': async (_req, res, auth) => {
    sendOk(res, getSyncStatus(auth.userId))
  },

  'POST /transcription_history/sync_settings': async (req, res, auth) => {
    const body = await readJson<{ cloud_retention?: number; sync_enabled?: boolean }>(req)
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.cloud_retention !== undefined && ![-1, 7, 30, 90].includes(body.cloud_retention)) ||
      (body.sync_enabled !== undefined && typeof body.sync_enabled !== 'boolean')) return sendError(res, 400, 'invalid_sync_settings', 400)
    sendOk(res, updateSyncSettings(auth.userId, body))
  },

  'POST /transcription_history/wipe': async (req, res, auth) => {
    const body = await readJson<{ request_id?: string }>(req)
    if (typeof body?.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.request_id)) return sendError(res, 400, 'invalid_wipe_request', 400)
    sendOk(res, wipeHistory(auth.userId, body.request_id))
  },

  'POST /transcription_history/acknowledge_hints': async (req, res, auth) => {
    const body = await readJson<{ params?: unknown; hints?: unknown }>(req)
    sendOk(res, acknowledgeHints(auth.userId, body.hints ?? body.params))
  },

  // ===== 语音 =====
  /**
   * 语音流程。multipart 上传，一次调用完成转写+润色。
   *
   * 字段约定：audio_file / mode / audio_context / parameters / duration。
   * 响应 { status:'OK', data:{ refine_text, raw_text, delivery } }。
   */
  'POST /ai/voice_flow': async (req, res, auth) => {
    // 未登录也允许（本地使用场景），但限流更严
    const ip = clientIp(req)
    if (!rateLimit(`voice:${auth.userId || ip}`, 60, 60_000)) {
      return sendError(res, 429, 'rate_limited', 429)
    }

    let form
    try {
      form = await readMultipart(req)
    } catch (err) {
      return sendError(res, 400, (err as Error).message, 400)
    }

    let audioContext: Record<string, unknown> = {}
    let parameters: Record<string, unknown> = {}
    try { audioContext = JSON.parse(form.fields.audio_context ?? '{}') } catch { /* 忽略畸形上下文 */ }
    try { parameters = JSON.parse(form.fields.parameters ?? '{}') } catch { /* 同上 */ }

    // 客户端已本地转写时只传 text，服务端跳过 ASR 直接润色。
    // 这是推荐架构：whisper 跑在用户本机，音频不出本机，服务器只做润色。
    const localText = form.fields.text

    if (!localText && !form.file) {
      return sendError(res, 400, 'audio_file_or_text_required', 400)
    }

    try {
      const result = await voiceFlow({
        mode: form.fields.mode ?? 'voice_transcript',
        audio: form.file?.data ?? Buffer.alloc(0),
        filename: form.file?.filename ?? 'audio.ogg',
        duration: Number(form.fields.duration ?? 0),
        audioContext,
        parameters,
        language: typeof audioContext.language === 'string' ? audioContext.language : undefined,
        text: localText
      })
      sendOk(res, result)
    } catch (err) {
      const msg = (err as Error).message
      const isDown = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
      sendError(res, isDown ? 503 : 502, isDown ? `asr_unavailable: ${msg}` : msg, isDown ? 503 : 502)
    }
  }
}

// MARK: - 服务器

/**
 * 路由查找：先精确匹配，再按 `:param` 模板匹配。
 *
 * 为什么需要模板匹配：帮助页路径含动态平台段
 * （/help/release-notes/macos 与 /help/release-notes/windows），
 * 枚举成两条会造成重复；而通配前缀匹配又会把
 * /help/troubleshooting/... 这类更具体的路径一起吞掉。
 */
function findHandler(method: string, pathname: string): Handler | undefined {
  const exact = routes[`${method} ${pathname}`]
  if (exact) return exact

  const parts = pathname.split('/')
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ')
    if (m !== method || !pattern.includes(':')) continue
    const patParts = pattern.split('/')
    if (patParts.length !== parts.length) continue
    const matched = patParts.every((seg, i) => seg.startsWith(':') || seg === parts[i])
    if (matched) return handler
  }
  return undefined
}

const CHALLENGE_ACTIONS: Record<string, ChallengeAction> = {
  '/oauth/register': 'register',
  '/oauth/login': 'login',
  '/oauth/signin_with_email': 'login',
  '/oauth/signin_with_google': 'login',
  '/oauth/auth_user_from_google': 'login',
  '/oauth/verify_secret_code': 'login',
  '/oauth/request_password_reset': 'login',
  '/oauth/reset_password': 'login'
}

const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  let url: URL
  try { url = new URL(req.url ?? '/', 'http://localhost') } catch { sendError(res, 400, 'invalid_url', 400); return }
  const key = `${req.method} ${url.pathname}`
  const handler = findHandler(req.method ?? 'GET', url.pathname)

  if (!handler) {
    sendError(res, 404, 'unknown_route', 404)
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/oauth/')) {
    const ip = clientIp(req)
    if (!rateLimit(`auth:${ip}`, 30, 60_000)
      || (url.pathname === '/oauth/register' && !rateLimit(`register:${ip}`, 10, 3600_000))) {
      res.setHeader('retry-after', '60')
      sendError(res, 429, 'rate_limited', 429)
      return
    }
  }

  const auth = authenticateRequest(url.pathname, req)
  if (!auth) {
    sendError(res, 401, 'unauthorized', 401)
    return
  }

  Promise.resolve().then(async () => {
    const action = req.method === 'POST' ? CHALLENGE_ACTIONS[url.pathname] : undefined
    if (action) {
      const body = await readJson<Record<string, unknown>>(req)
      const legacy = /^OpenType\/0\.2\.0-beta\.(\d+)(?:\s|$)/.exec(req.headers['user-agent'] ?? '')
      if (challengeRequired() && !body.turnstile_token && legacy && Number(legacy[1]) <= 24) {
        throw new HttpError(426, '请升级到 OpenType 0.2.0-beta.25 或更新版本，在应用内完成安全验证后登录。')
      }
      await verifyChallenge(body.turnstile_token, action, clientIp(req))
    }
    await handler(req, res, auth)
  }).catch((err) => {
    if (!(err instanceof HttpError)) console.error(`[error] ${key}: request_failed`)
    if (!res.headersSent) sendError(res, err instanceof HttpError ? err.status : 500,
      err instanceof HttpError ? err.message : 'internal_server_error')
  })
})
server.headersTimeout = 15_000
server.requestTimeout = 120_000
server.keepAliveTimeout = 5000

const cleanupCloudHistory = () => {
  try { expireCloudHistory() } catch { console.warn('[opentype] cloud retention cleanup will retry') }
}
cleanupCloudHistory()
const cloudRetentionTimer = setInterval(cleanupCloudHistory, 60_000); cloudRetentionTimer.unref()
server.listen(PORT, HOST, () => {
  console.log(`[opentype] listening on http://${HOST}:${PORT}`)
  console.log(`[opentype] db: ${DB_PATH}`)
  console.log(`[opentype] email delivery: ${mailConfigured() ? 'configured' : 'unavailable'}`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearInterval(cloudRetentionTimer)
    console.log(`[opentype] ${sig} received, shutting down`)
    server.close(() => { closeDb(); process.exit(0) })
    setTimeout(() => { server.closeAllConnections(); closeDb(); process.exit(0) }, 10_000).unref()
  })
}
