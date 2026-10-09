// 上下文采集的隐私护栏。
//
// 内置一份「敏感应用清单」——密码管理器、终端、IM 工具、
// 远程桌面。在这些应用里采集输入框内容并上传，等同于泄露密码与私钥。
// 同时服务端可通过 /app/get_blacklist_domain 动态下发需脱敏的域名，
// 使发现新的敏感站点无需发版即可覆盖。

/** 不采集上下文的应用（bundle id）。命中则 inputContext 与 URL 全部脱敏。 */
export const SENSITIVE_APP_BUNDLE_IDS = new Set([
  // 密码管理器
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'org.keepassxc.keepassxc',
  // 终端与开发工具（可能含密钥、token）
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.github.wez.wezterm',
  'com.conductor.app',
  // IM（私密对话）
  'com.tencent.xinWeChat',
  'jp.naver.line.mac',
  'com.tencent.qq',
  // 邮件客户端（私密通信）
  'org.mozilla.thunderbird',
  'com.apple.mail'
])

/** Windows 侧的应用名（可执行文件名）。 */
export const SENSITIVE_APP_EXE = new Set([
  'Cursor.exe', 'WXWork.exe', 'WeMail.exe', 'AliIM.exe', 'QQ.exe',
  'mRemoteNG.exe', 'Trae CN.exe', 'Trae.exe', 'SunBrowser.exe',
  'RDCMan.exe', 'trillian.exe', 'Hidemaru.exe', 'TuruKame.exe',
  '360ChromeX.exe', 'MailClient.exe', 'tty7-app.exe'
])

/**
 * 不采集上下文的 URL 前缀。
 * 注意：这里不是「敏感」而是「内容不可靠」——Google Docs 与腾讯文档的
 * 编辑区在 AX 树里结构特殊，采到的上下文是噪音而非有效语境。
 */
export const URL_BLACKLIST_PREFIX = [
  'https://docs.google.com/document/d',
  'https://docs.qq.com/doc/',
  'https://docs.qq.com/sheet/'
]

/** 需要特化上下文采集的 URL 前缀（设计工具 canvas 内容需特殊提取）。 */
export const URL_WHITELIST_PREFIX = [
  'https://www.figma.com/design/'
]

export interface ContextDecision {
  /** 是否上传上下文（false 时全部脱敏） */
  allowContext: boolean
  /** 是否需要在 URL 黑名单下走替代采集策略 */
  useAlternativeStrategy: boolean
  reason: string
}

/** 判定当前上下文是否可上传。 */
export function decideContext(bundleId: string, webDomain: string, webUrl: string, appName = ''): ContextDecision {
  if (SENSITIVE_APP_BUNDLE_IDS.has(bundleId) || SENSITIVE_APP_EXE.has(appName)) {
    return { allowContext: false, useAlternativeStrategy: false, reason: 'sensitive_app' }
  }

  const url = webUrl.toLowerCase()
  if (URL_BLACKLIST_PREFIX.some((p) => url.startsWith(p.toLowerCase()))) {
    return { allowContext: false, useAlternativeStrategy: true, reason: 'url_blacklist' }
  }

  if (URL_WHITELIST_PREFIX.some((p) => url.startsWith(p.toLowerCase()))) {
    return { allowContext: true, useAlternativeStrategy: true, reason: 'url_whitelist' }
  }

  return { allowContext: true, useAlternativeStrategy: false, reason: 'default' }
}

/**
 * 服务端下发的域名黑名单缓存。
 * 缓存周期按天，避免每次采集都请求；命中则与本地黑名单同样脱敏。
 */
export class RemoteBlacklist {
  private domains: string[] = []
  private fetchedAt = 0
  private static readonly TTL_MS = 24 * 3600 * 1000

  constructor(private readonly fetcher: () => Promise<string[]>) {}

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < RemoteBlacklist.TTL_MS) return
    try {
      this.domains = await this.fetcher()
      this.fetchedAt = Date.now()
    } catch {
      // 拉取失败沿用旧列表：宁可少脱敏也不能因为网络问题放行
    }
  }

  matches(domain: string): boolean {
    if (!domain) return false
    const d = domain.toLowerCase()
    return this.domains.some((entry) => d === entry || d.endsWith(`.${entry}`))
  }
}
