// 服务端协议常量。
//
// 独立于 HTTP 客户端：这些是「协议事实」，与用哪个 HTTP 库无关。
// 拆出来后可以被纯逻辑测试覆盖，不必加载 undici 等运行时依赖。

/** 本地模式枚举。 */
export type LocalMode = 'voice_transcript' | 'voice_command' | 'voice_translation'

/**
 * 本地模式 → 服务端 mode 值。
 *
 * 二者不同名：本地叫 voice_command，服务端叫 ask_anything。
 * 直接上传本地枚举值会被服务端拒绝或走进错误分支——这是最容易踩的坑。
 */
export const SERVER_MODE: Record<LocalMode, string> = {
  voice_transcript: 'transcript',
  voice_command: 'ask_anything',
  voice_translation: 'translation'
}

/** 语音上传超时（毫秒）。长语音 + 弱网下更短会误判失败。 */
export const VOICE_FLOW_TIMEOUT_MS = 40_000

/** 音频编码参数。与真实产品一致。 */
export const AUDIO_PARAMS = {
  sampleRate: 16000,
  channels: 1,
  sampleSize: 16,
  /** 采集缓冲帧数，约 256ms，兼顾延迟与 IPC 频次 */
  processorBufferSize: 4096,
  opusBitrate: 32_000,
  opusFrameSizeMs: 20,
  opusComplexity: 10,
  vbr: true,
  signal: 'auto'
} as const

// MARK: - 认证协议

/**
 * 登录方式 → 登录页路径后缀。
 * 映射约定：createAppLoginUrl 的 next 参数。
 */
export const LOGIN_PROVIDER_PATH: Record<string, string> = {
  google: '/login/google',
  email: '/login/email',
  apple: '/login/apple',
  sso: '/login/sso',
  login: '/login'
}

/** OAuth 端点。 */
export const OAUTH_ENDPOINTS = {
  SIGNIN_WITH_GOOGLE: '/oauth/signin_with_google',
  AUTH_USER_FROM_GOOGLE: '/oauth/auth_user_from_google',
  REFRESH_TOKEN: '/oauth/refresh_access_token',
  SIGNIN_WITH_EMAIL: '/oauth/signin_with_email',
  VERIFY_SECRET_CODE: '/oauth/verify_secret_code',
  LOGOUT: '/oauth/logout',
  EXCHANGE_APP_LOGIN_CODE: '/oauth/exchange_app_login_code'
} as const

/**
 * 不携带 Authorization 的端点。
 *
 * 刷新接口必须排除，否则过期 token 会让刷新也失败——
 * 这是「token 过期后无法自愈」的经典陷阱。
 */
export const AUTH_SKIP_ENDPOINTS: readonly string[] = [
  OAUTH_ENDPOINTS.REFRESH_TOKEN,
  '/get_blacklist_domain',
  '/app/get_blacklist_domain'
]

/** 登录页路径（客户端发起的授权入口）。 */
export const APP_AUTH_PATH = '/login/app/auth'

/** 应用标识，登出接口需要。 */
export const APP_CLIENT_TAG = 'opentype_desktop'

/**
 * token 提前刷新窗口（毫秒）。
 *
 * 不等到过期才刷新：网络往返有延迟，踩点刷新会让用户撞上 401。
 */
export const TOKEN_REFRESH_LEEWAY_MS = 60_000
