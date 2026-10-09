// 法律与联系页面（隐私政策 / 服务条款 / 联系我们）。
//
// 渲染层「关于」页与登录授权页的链接指向 `${host}/privacy|/terms|/contact`，
// 用 target=_blank 打开（主进程已改为交给系统浏览器）。
// 这些路径不带鉴权头，必须在 AUTH_SKIP 里豁免。

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    font-size: 14px; line-height: 1.7; color: #1a1a1a;
    background: #fff; padding: 40px 24px; -webkit-font-smoothing: antialiased;
  }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
  h2 { font-size: 16px; font-weight: 600; margin: 26px 0 8px; }
  p, li { color: #333; }
  ul { padding-left: 20px; margin: 6px 0; }
  li { margin-bottom: 4px; }
  .updated { font-size: 12px; color: #8a8a8e; margin-bottom: 18px; }
  a { color: #2563eb; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1e; color: #e8e8e8; }
    p, li { color: #c7c7cc; }
    .updated { color: #8a8a8e; }
    a { color: #60a5fa; }
  }
`

interface Page {
  title: { zh: string; en: string }
  updated: string
  body: { zh: string; en: string }
}

const PRIVACY: Page = {
  title: { zh: '隐私政策', en: 'Privacy Policy' },
  updated: '2026-10-07',
  body: {
    zh: `
      <h2>我们处理什么数据</h2>
      <ul>
        <li><strong>语音音频</strong>：仅在你按住热键说话时采集，在本机完成转写；音频不会上传到云端保存。</li>
        <li><strong>转写文本</strong>：润色后的文本与历史记录会同步到你的账号，用于跨设备查看历史。</li>
        <li><strong>账号信息</strong>：电子邮件地址与登录凭据（密码经 PBKDF2 加盐哈希存储）。</li>
        <li><strong>上下文信息</strong>：为提供「结合上下文润色」，会读取前台应用的名称与输入框选区，仅用于当次请求。</li>
      </ul>
      <h2>我们不会做的事</h2>
      <ul>
        <li>不出售、不共享你的个人数据给第三方。</li>
        <li>不使用你的语音或文本训练模型。</li>
        <li>不在云端存储原始音频。</li>
      </ul>
      <h2>你的权利</h2>
      <p>你可以随时在「历史记录」中删除单条或全部记录，也可以在「设置 → 账户」中注销账号，删除后云端数据将被清除。</p>
      <h2>联系方式</h2>
      <p>隐私相关问题请联系 <a href="mailto:hello@opentype.dev">hello@opentype.dev</a>。</p>`,
    en: `
      <h2>What we process</h2>
      <ul>
        <li><strong>Voice audio</strong>: captured only while you hold the hotkey, transcribed on your device. Audio is never stored in the cloud.</li>
        <li><strong>Transcripts</strong>: refined text and history sync to your account so you can review them across devices.</li>
        <li><strong>Account</strong>: email address and credentials (passwords are stored as salted PBKDF2 hashes).</li>
        <li><strong>Context</strong>: to refine with context, the frontmost app name and text selection may be read, used only for that request.</li>
      </ul>
      <h2>What we never do</h2>
      <ul>
        <li>We never sell or share your personal data with third parties.</li>
        <li>We never train models on your voice or text.</li>
        <li>We never store raw audio in the cloud.</li>
      </ul>
      <h2>Your rights</h2>
      <p>Delete any or all history entries at any time, or delete your account in Settings → Account; cloud data is removed with it.</p>
      <h2>Contact</h2>
      <p>For privacy questions, email <a href="mailto:hello@opentype.dev">hello@opentype.dev</a>.</p>`
  }
}

const TERMS: Page = {
  title: { zh: '服务条款', en: 'Terms of Service' },
  updated: '2026-10-07',
  body: {
    zh: `
      <h2>服务说明</h2>
      <p>OpenType 是一个语音输入工具：按住热键说话，松开后将润色后的文本注入当前应用。本服务按「现状」提供。</p>
      <h2>账号</h2>
      <ul>
        <li>你需要对账号下的活动负责，请妥善保管登录凭据。</li>
        <li>你可以随时注销账号，关联数据将被删除。</li>
      </ul>
      <h2>可接受使用</h2>
      <p>不得利用本服务生成违法、侵权或有害内容；不得滥用接口或干扰服务运行。</p>
      <h2>责任限制</h2>
      <p>在法律允许的最大范围内，我们不对间接损失承担责任。转写与润色结果可能不完全准确，重要内容请自行核对。</p>
      <h2>条款变更</h2>
      <p>条款更新时会在此页面公布，继续使用即表示接受更新后的条款。</p>`,
    en: `
      <h2>The service</h2>
      <p>OpenType is a voice input tool: hold the hotkey, speak, and get polished text inserted into the current app. The service is provided "as is".</p>
      <h2>Accounts</h2>
      <ul>
        <li>You are responsible for activity under your account; keep your credentials safe.</li>
        <li>You may delete your account at any time; associated data will be removed.</li>
      </ul>
      <h2>Acceptable use</h2>
      <p>Do not use the service to generate unlawful, infringing, or harmful content, and do not abuse or disrupt the service.</p>
      <h2>Limitation of liability</h2>
      <p>To the maximum extent permitted by law, we are not liable for indirect damages. Transcription and refinement may be inaccurate — verify important content yourself.</p>
      <h2>Changes</h2>
      <p>Updates to these terms are posted on this page; continued use constitutes acceptance.</p>`
  }
}

const CONTACT: Page = {
  title: { zh: '联系我们', en: 'Contact Us' },
  updated: '2026-10-07',
  body: {
    zh: `
      <h2>获取帮助</h2>
      <p>使用问题、功能建议或故障反馈：</p>
      <ul>
        <li>邮件：<a href="mailto:hello@opentype.dev">hello@opentype.dev</a></li>
        <li>应用内「设置 → 帮助」可查看麦克风排障与更新说明。</li>
      </ul>`,
    en: `
      <h2>Get help</h2>
      <p>Questions, feature requests, or bug reports:</p>
      <ul>
        <li>Email: <a href="mailto:hello@opentype.dev">hello@opentype.dev</a></li>
        <li>In-app: Settings → Help for microphone troubleshooting and release notes.</li>
      </ul>`
  }
}

const PAGES: Record<string, Page> = { privacy: PRIVACY, terms: TERMS, contact: CONTACT }

/** 渲染法律/联系页面。name 限定为 PAGES 的键，未知名称返回 null 由路由回 404。 */
export function renderLegalPage(name: string, lang: string): string | null {
  const page = PAGES[name]
  if (!page) return null
  const zh = lang.toLowerCase().startsWith('zh')
  const title = zh ? page.title.zh : page.title.en
  return `<!DOCTYPE html>
<html lang="${esc(zh ? 'zh-CN' : 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - OpenType</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<div class="updated">${zh ? '更新于' : 'Last updated'} ${esc(page.updated)}</div>
${zh ? page.body.zh : page.body.en}
</main></body></html>`
}
