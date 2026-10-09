// 认证服务：PKCE 登录、token 存储、自动刷新、多账号隔离。
//
// 几个关键设计点：
//
// 1. **PKCE 而非 client_secret**：桌面应用无法保守 secret（二进制可被提取），
//    所以用 code_verifier/code_challenge 证明「发起授权和兑换授权码的是同一个客户端」。
//
// 2. **刷新接口不带旧 token**：过期 token 会让刷新请求本身被拒，导致无法自愈。
//
// 3. **提前刷新**：不等到过期才刷，否则用户会踩点撞上 401。
//
// 4. **账号代际隔离**：切换账号时递增 generation，在途请求自动失效——
//    比手动取消 Promise 更可靠（见 SyncEngine 的 sessionGeneration 设计）。

import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { serviceRequest as request } from './network'
import { serviceEndpoint } from '../../shared/network-policy'
import {
  OAUTH_ENDPOINTS, LOGIN_PROVIDER_PATH, APP_AUTH_PATH,
  APP_CLIENT_TAG, TOKEN_REFRESH_LEEWAY_MS
} from './protocol'

export interface AuthUser {
  user_id: string
  /** Origin binding added by the official account store. */
  server_url?: string
  client_user_id?: string
  email?: string
  access_token: string
  refresh_token?: string
  /** access_token 过期时间（epoch 毫秒）。服务端可能返回 expires_in 或 expires_at。 */
  expires_at?: number
  login_time?: number
}

export interface AuthInfo {
  token: string | null
  userId: string | null
}

export interface AuthServiceOptions {
  apiBaseUrl: string
  webBaseUrl: string
  appVersion: string
  /** 持久化读写。主进程通过系统安全存储保护凭据。 */
  load: () => Promise<AuthUser | null>
  save: (user: AuthUser | null) => Promise<void>
  /** token 变更通知（用于同步引擎等消费方） */
  onUserChanged?: (user: AuthUser | null) => void
}

interface PendingLogin {
  state: string
  codeVerifier: string
  createdAt: number
}

/** PKCE 的 pending 状态有效期。超时后 code_verifier 应作废，防止长期悬挂。 */
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000

export class AuthService {
  private currentUser: AuthUser | null = null
  private pendingLogin: PendingLogin | null = null
  private refreshPromise: Promise<boolean> | null = null
  /** 账号代际。切换账号时递增，在途请求据此判断是否已失效。 */
  private generation = 0
  /** 本地回调服务端口。为 0 时不传 redirect_uri（退回深链接）。 */
  private localCallbackPort = 0

  constructor(private readonly options: AuthServiceOptions) {}

  // MARK: - 生命周期

  async initialize(): Promise<void> {
    this.currentUser = await this.options.load()
  }

  get isLoggedIn(): boolean {
    return this.currentUser !== null
  }

  /** 设置本地回调端口。授权页完成后请求它而非深链接。 */
  setLocalCallbackPort(port: number): void {
    this.localCallbackPort = port
  }

  get userId(): string | null {
    return this.currentUser?.user_id ?? null
  }

  /** 供 ApiClient 使用：返回可用 token，必要时先刷新。 */
  async getAccessToken(): Promise<string | null> {
    if (!this.currentUser) return null
    serviceEndpoint(this.options.apiBaseUrl)

    if (this.isTokenExpiring()) {
      const ok = await this.refresh()
      // 刷新失败不清空用户：可能是网络问题，让调用方走 401 分支再决定
      if (!ok) return this.currentUser?.access_token ?? null
    }
    return this.currentUser?.access_token ?? null
  }

  getAuthInfo(): AuthInfo {
    return { token: this.currentUser?.access_token ?? null, userId: this.userId }
  }

  // MARK: - PKCE 登录

  /**
   * 生成登录 URL。
   *
   * code_verifier 用两个 randomUUID 拼接，
   * code_challenge = base64url(sha256(code_verifier))。
   */
  createLoginUrl(provider: keyof typeof LOGIN_PROVIDER_PATH | string = 'login'): string {
    const next = LOGIN_PROVIDER_PATH[provider]
    if (!next) throw new Error(`unknown login provider: ${provider}`)
    const loginEndpoint = serviceEndpoint(this.options.webBaseUrl, APP_AUTH_PATH)
    serviceEndpoint(this.options.apiBaseUrl)
    this.generation += 1

    const codeVerifier = randomUUID() + randomUUID()
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url')          // base64url 而非 base64：避免 +/ 需要 URL 编码
    const state = randomUUID()

    this.pendingLogin = { state, codeVerifier, createdAt: Date.now() }

    const url = new URL(loginEndpoint)
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('state', state)
    url.searchParams.set('next', next)
    // 本地回调地址：授权页完成后直接请求它，不依赖系统深链接。
    // 开发态下 opentype:// 的 bundle id 是 com.github.electron，
    // 系统无法路由到本应用；本地 HTTP 回调绕开这个限制。
    if (this.localCallbackPort) {
      url.searchParams.set('redirect_uri', `http://127.0.0.1:${this.localCallbackPort}/auth/callback`)
    }
    return url.toString()
  }

  /**
   * 用回调返回的 code 兑换 token。
   *
   * state 必须与发起时一致——这是防 CSRF 的关键校验，
   * 缺了它攻击者可诱导用户用攻击者的 code 完成登录（会话固定）。
   */
  async exchangeLoginCode(code: string, state: string): Promise<{ success: boolean; detail?: string }> {
    const pending = this.pendingLogin
    if (!pending) return { success: false, detail: 'no_pending_login' }

    if (Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS) {
      this.pendingLogin = null
      return { success: false, detail: 'pending_login_expired' }
    }

    // state 不匹配直接作废，且清空 pending 防止重放
    if (state !== pending.state) {
      this.pendingLogin = null
      return { success: false, detail: 'state_mismatch' }
    }

    try {
      const gen = this.generation
      const res = await request(serviceEndpoint(this.options.apiBaseUrl, OAUTH_ENDPOINTS.EXCHANGE_APP_LOGIN_CODE), {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': `OpenType/${this.options.appVersion}`
        },
        body: JSON.stringify({
          code,
          state,
          code_verifier: pending.codeVerifier
        })
      })
      const payload = await res.body.json() as Record<string, any>
      if (gen !== this.generation || this.pendingLogin !== pending) return { success: false, detail: 'session_changed' }
      if (payload?.status !== 'OK' || !payload?.data) {
        return { success: false, detail: payload?.detail ?? `http_${res.statusCode}` }
      }

      await this.setUser(this.normalizeUser(payload.data))
      this.pendingLogin = null
      return { success: true }
    } catch (err) {
      return { success: false, detail: (err as Error).message }
    }
  }

  // MARK: - 密码注册与登录

  /**
   * 注册并登录。
   *
   * 与 PKCE 流程并存：PKCE 需要浏览器授权页，而自建部署下
   * 直接密码登录更实际（无需邮件服务、无需前端页面）。
   */
  async register(email: string, password: string, displayName?: string): Promise<{ success: boolean; detail?: string }> {
    return this.passwordAuth('/oauth/register', { email, password, display_name: displayName })
  }

  async loginWithPassword(email: string, password: string): Promise<{ success: boolean; detail?: string }> {
    return this.passwordAuth('/oauth/login', { email, password })
  }

  private async passwordAuth(
    path: string,
    body: Record<string, unknown>
  ): Promise<{ success: boolean; detail?: string }> {
    try {
      const endpoint = serviceEndpoint(this.options.apiBaseUrl, path)
      const gen = ++this.generation
      this.pendingLogin = null
      const res = await request(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': `OpenType/${this.options.appVersion}`
        },
        body: JSON.stringify(body)
      })
      const payload = await res.body.json() as Record<string, any>
      if (gen !== this.generation) return { success: false, detail: 'session_changed' }
      if (payload?.status !== 'OK' || !payload?.data?.access_token) {
        return { success: false, detail: payload?.detail ?? `http_${res.statusCode}` }
      }
      const d = payload.data
      await this.setUser({
        user_id: d.user_id ?? d.user?.user_id,
        email: d.user?.email ?? String(body.email ?? ''),
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: this.computeExpiry(d),
        login_time: Date.now()
      })
      return { success: true }
    } catch (err) {
      return { success: false, detail: (err as Error).message }
    }
  }

  // MARK: - 刷新

  private isTokenExpiring(): boolean {
    const expiresAt = this.currentUser?.expires_at
    if (!expiresAt) return false          // 无过期信息则不主动刷，交给 401 触发
    return Date.now() >= expiresAt - TOKEN_REFRESH_LEEWAY_MS
  }

  /**
   * 刷新 token。并发调用共享同一个 Promise，避免同时发出多个刷新请求
   * （服务端通常会因 refresh_token 轮换而让后到的请求失败）。
   */
  async refresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doRefresh().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  private async doRefresh(): Promise<boolean> {
    const user = this.currentUser
    if (!user?.refresh_token) return false

    const gen = this.generation
    try {
      const res = await request(serviceEndpoint(this.options.apiBaseUrl, OAUTH_ENDPOINTS.REFRESH_TOKEN), {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': `OpenType/${this.options.appVersion}`
        },
        // 关键：不携带旧的 Authorization 头。过期 token 会让刷新本身被拒。
        body: JSON.stringify({ refresh_token: user.refresh_token })
      })

      // 账号在刷新期间被切换 → 丢弃结果，避免把 A 的 token 写到 B 身上
      if (gen !== this.generation) { res.body.destroy(); return false }

      const payload = await res.body.json() as Record<string, any>
      if (gen !== this.generation) return false
      if (payload?.status !== 'OK' || !payload?.data?.access_token) return false

      await this.setUser({
        ...user,
        access_token: payload.data.access_token,
        refresh_token: payload.data.refresh_token ?? user.refresh_token,
        expires_at: this.computeExpiry(payload.data)
      })
      return true
    } catch {
      return false
    }
  }

  // MARK: - 登出与账号切换

  /**
   * 登出。先清本地登录态，再尽力通知服务端吊销 refresh_token。
   * 服务端吊销失败不阻塞本地清理——否则用户会「登不出去」。
   */
  async logout(): Promise<void> {
    const user = this.currentUser
    this.generation += 1
    this.pendingLogin = null
    // Local logout and account isolation must not wait on a slow/offline server.
    await this.setUser(null)
    if (user?.refresh_token) {
      try {
        const res = await request(serviceEndpoint(this.options.apiBaseUrl, OAUTH_ENDPOINTS.LOGOUT), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${user.access_token}`,
            'user-agent': `OpenType/${this.options.appVersion}`
          },
          body: JSON.stringify({ app: APP_CLIENT_TAG, refresh_token: user.refresh_token }),
          signal: AbortSignal.timeout(5000)
        })
        await res.body.dump()
      } catch { /* 网络失败也继续清本地 */ }
    }
  }

  /** 切换到另一个账号：递增代际使在途请求失效。 */
  private async setUser(user: AuthUser | null): Promise<void> {
    // 账号变化时递增代际
    if (user?.user_id !== this.currentUser?.user_id) {
      this.generation += 1
    }
    this.currentUser = user
    const gen = this.generation
    await this.options.save(user)
    if (gen === this.generation && this.currentUser === user) this.options.onUserChanged?.(user)
  }

  /** 当前代际。外部异步流程可用它判断结果是否仍有效。 */
  get currentGeneration(): number {
    return this.generation
  }

  isCurrentGeneration(gen: number): boolean {
    return gen === this.generation
  }

  // MARK: - 内部

  private normalizeUser(data: Record<string, any>): AuthUser {
    return {
      user_id: data.user_id ?? data.userId,
      client_user_id: data.client_user_id,
      email: data.email,
      access_token: data.access_token ?? data.token,
      refresh_token: data.refresh_token,
      expires_at: this.computeExpiry(data),
      login_time: Date.now()
    }
  }

  /** 服务端可能返回 expires_in（秒）或 expires_at（毫秒），两者都兼容。 */
  private computeExpiry(data: Record<string, any>): number | undefined {
    if (typeof data.expires_at === 'number') return data.expires_at
    if (typeof data.expires_in === 'number') return Date.now() + data.expires_in * 1000
    return undefined
  }
}

/** 生成一个高熵的 state（与 PKCE 的 state 用途相同，供外部复用）。 */
export function generateState(): string {
  return randomBytes(16).toString('base64url')
}
