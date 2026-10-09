// 帮助页面 HTML（更新说明 / 麦克风排障）。
//
// 存在的理由：前端「更新说明」与麦克风排障都用 <iframe src="..."> 直接加载
// `${baseUrl}/help/release-notes/${platform}?noHeader=1&noFooter=1&noTitle=1&lang=xx`。
// iframe 请求不带 Authorization 头，所以这些路径必须在服务端豁免鉴权，
// 否则前端只会看到 401 的 JSON 而不是页面。
//
// 自包含单页（内联样式，无外部资源）：页面在 iframe 里渲染，
// 依赖外部 CSS/字体会让它在弱网下白屏。
//
// 三个查询参数是前端用来裁剪页眉/页脚的：
//   noHeader=1 / noFooter=1 / noTitle=1
// 前端已经自带弹窗标题栏，服务端再画一遍会出现双标题。

export interface HelpPageParams {
  /** macos / windows */
  platform: string
  /** 界面语言，如 zh-CN / en */
  lang: string
  noHeader: boolean
  noFooter: boolean
  noTitle: boolean
}

/** HTML 转义。lang 来自查询串，必须转义后再插入。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/** 是否中文界面。仅用于选择文案，不做严格 locale 匹配。 */
function isZh(lang: string): boolean {
  return lang.toLowerCase().startsWith('zh')
}

interface Note {
  version: string
  date: string
  items: { zh: string; en: string }[]
}

/**
 * 更新说明条目。
 *
 * 这是 OpenType 自己的版本记录，照抄上游内容会误导用户。
 * 新增版本时在数组头部插入。
 */
const RELEASE_NOTES: Note[] = [
  {
    version: '0.1.0',
    date: '2026-10-05',
    items: [
      { zh: '首个版本：本地语音转写 + AI 润色', en: 'First release: local dictation with AI refinement' },
      { zh: '支持听写、提问、翻译三种模式', en: 'Dictation, Ask Anything, and Translation modes' },
      { zh: '云端历史同步与账号体系', en: 'Cloud history sync with accounts' },
      { zh: '本地识别，音频不出本机', en: 'On-device transcription — audio never leaves your Mac' }
    ]
  }
]

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    font-size: 14px; line-height: 1.6; color: #1a1a1a;
    background: #fff; padding: 20px 24px 32px;
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1e; color: #e8e8e8; }
    .date { color: #8a8a8e; }
    .item::before { background: #4a4a4e; }
    h2 { border-color: #2c2c2e; }
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  h2 {
    font-size: 15px; font-weight: 600; margin: 22px 0 10px;
    padding-bottom: 8px; border-bottom: 1px solid #ececec;
    display: flex; align-items: baseline; gap: 10px;
  }
  .date { font-size: 12px; font-weight: 400; color: #8a8a8e; }
  ul { list-style: none; }
  .item { position: relative; padding-left: 16px; margin-bottom: 7px; }
  .item::before {
    content: ''; position: absolute; left: 2px; top: 9px;
    width: 4px; height: 4px; border-radius: 50%; background: #b0b0b4;
  }
  .platform { font-size: 12px; color: #8a8a8e; margin-top: 2px; }
`

/** 渲染更新说明页。 */
export function renderReleaseNotesPage(p: HelpPageParams): string {
  const zh = isZh(p.lang)
  const notes = RELEASE_NOTES.map((n) => `
    <h2>${esc(n.version)}<span class="date">${esc(n.date)}</span></h2>
    <ul>${n.items.map((i) => `<li class="item">${esc(zh ? i.zh : i.en)}</li>`).join('')}</ul>
  `).join('')

  const title = zh ? '更新说明' : 'Release Notes'
  const heading = p.noTitle ? '' : `<h1>${title}</h1>`
  const platform = p.noTitle ? '' : `<div class="platform">${esc(p.platform)}</div>`

  return `<!DOCTYPE html>
<html lang="${esc(p.lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${heading}${platform}${notes}
</body>
</html>`
}

/**
 * 渲染麦克风排障页。
 *
 * 前端在麦克风检测异常时把用户引到这里（`/help/troubleshooting/microphone-unavailable`）。
 * 步骤按「最可能的原因排前面」排序：权限没给 > 设备被独占 > 设备静音。
 */
export function renderMicTroubleshootingPage(p: HelpPageParams): string {
  const zh = isZh(p.lang)
  const title = zh ? '麦克风不可用' : 'Microphone unavailable'
  const steps = zh
    ? [
        '打开「系统设置」→「隐私与安全性」→「麦克风」，确认 OpenType 已勾选。',
        '完全退出 OpenType（菜单栏图标 → 退出）后重新打开，权限变更需要重启生效。',
        '检查是否有其他应用正在占用麦克风（会议软件、录屏工具）。',
        '打开「系统设置」→「声音」→「输入」，确认输入设备未静音且音量不为 0。',
        '在 OpenType 设置里切换麦克风设备，蓝牙耳机需要先在系统里连接成功。'
      ]
    : [
        'Open System Settings → Privacy & Security → Microphone and enable OpenType.',
        'Quit OpenType completely (menu bar icon → Quit) and reopen — permission changes need a restart.',
        'Check whether another app is holding the microphone (meeting apps, screen recorders).',
        'Open System Settings → Sound → Input and confirm the device is not muted and volume is above 0.',
        'Switch the microphone device in OpenType settings; Bluetooth headsets must be connected in the system first.'
      ]

  return `<!DOCTYPE html>
<html lang="${esc(p.lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>${STYLE}
  ol { list-style: none; counter-reset: step; }
  .step { position: relative; padding-left: 32px; margin-bottom: 14px; counter-increment: step; }
  .step::before {
    content: counter(step); position: absolute; left: 0; top: 1px;
    width: 20px; height: 20px; border-radius: 50%;
    background: #f0f0f2; color: #4a4a4e;
    font-size: 11px; font-weight: 600;
    display: flex; align-items: center; justify-content: center;
  }
  @media (prefers-color-scheme: dark) {
    .step::before { background: #2c2c2e; color: #c8c8cc; }
  }
</style>
</head>
<body>
${p.noTitle ? '' : `<h1>${title}</h1>`}
<ol>${steps.map((s) => `<li class="step">${esc(s)}</li>`).join('')}</ol>
</body>
</html>`
}
