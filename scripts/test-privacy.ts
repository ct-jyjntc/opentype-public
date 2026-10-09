// 隐私护栏与协议映射测试。
// 这两块是隐私护栏逻辑，错了会直接导致用户数据泄露或请求失败。

import { decideContext, SENSITIVE_APP_BUNDLE_IDS, RemoteBlacklist } from '../src/main/services/privacy.ts'
import { SERVER_MODE } from '../src/main/services/protocol.ts'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

console.log('\n=== 服务端模式映射 ===')
// 模式名映射：本地 voice_command 在服务端叫 ask_anything
check('transcript 映射', SERVER_MODE.voice_transcript, 'transcript')
check('voice_command → ask_anything（关键）', SERVER_MODE.voice_command, 'ask_anything')
check('translation 映射', SERVER_MODE.voice_translation, 'translation')
check('映射值不含本地枚举名', Object.values(SERVER_MODE).includes('voice_command'), false)

console.log('\n=== 隐私护栏：敏感应用 ===')
check('1Password 被拦截', decideContext('com.1password.1password', '', '').allowContext, false)
check('iTerm 被拦截', decideContext('com.googlecode.iterm2', '', '').allowContext, false)
check('微信被拦截', decideContext('com.tencent.xinWeChat', '', '').allowContext, false)
check('拦截原因标记正确', decideContext('com.apple.Terminal', '', '').reason, 'sensitive_app')
check('普通编辑器放行', decideContext('com.apple.TextEdit', '', '').allowContext, true)
check('浏览器放行', decideContext('com.google.Chrome', 'example.com', 'https://example.com/').allowContext, true)
check('Windows 应用名也被拦截',
  decideContext('', '', '', 'RDCMan.exe').allowContext, false)

console.log('\n=== 隐私护栏：URL 黑名单/白名单 ===')
check('Google Docs 被拦截',
  decideContext('com.google.Chrome', 'docs.google.com', 'https://docs.google.com/document/d/abc').allowContext, false)
check('腾讯文档被拦截',
  decideContext('com.google.Chrome', 'docs.qq.com', 'https://docs.qq.com/doc/xyz').allowContext, false)
check('文档类走替代策略',
  decideContext('com.google.Chrome', 'docs.google.com', 'https://docs.google.com/document/d/x').useAlternativeStrategy, true)
check('Figma 放行但走特化策略',
  decideContext('com.google.Chrome', 'figma.com', 'https://www.figma.com/design/abc').useAlternativeStrategy, true)
check('Figma 仍允许采集',
  decideContext('com.google.Chrome', 'figma.com', 'https://www.figma.com/design/abc').allowContext, true)
// 大小写不敏感：用户可能输入混合大小写的 URL
check('URL 匹配大小写不敏感',
  decideContext('com.google.Chrome', 'x', 'HTTPS://DOCS.GOOGLE.COM/DOCUMENT/D/abc').allowContext, false)

console.log('\n=== 敏感清单完整性 ===')
check('密码管理器在清单内', SENSITIVE_APP_BUNDLE_IDS.has('com.agilebits.onepassword7'), true)
check('终端在清单内', SENSITIVE_APP_BUNDLE_IDS.has('com.apple.Terminal'), true)

console.log('\n=== 服务端域名黑名单 ===')
{
  let calls = 0
  const bl = new RemoteBlacklist(async () => { calls++; return ['bank.example.com', 'mail.example.com'] })

  await bl.refresh()
  check('首次拉取后命中', bl.matches('bank.example.com'), true)
  check('子域名也命中', bl.matches('secure.bank.example.com'), true)
  check('不相关域名不命中', bl.matches('example.org'), false)
  check('空域名不命中', bl.matches(''), false)

  // TTL 内不应重复请求
  await bl.refresh()
  check('TTL 内不重复拉取', calls, 1)

  await bl.refresh(true)
  check('强制刷新会重新拉取', calls, 2)
}

{
  // 拉取失败必须沿用旧列表：网络问题不能导致脱敏失效
  let shouldFail = false
  const bl = new RemoteBlacklist(async () => {
    if (shouldFail) throw new Error('network down')
    return ['bank.example.com']
  })
  await bl.refresh()
  shouldFail = true
  await bl.refresh(true)
  check('拉取失败沿用旧列表', bl.matches('bank.example.com'), true)
}

{
  // 首次就失败时应为空列表，但绝不能抛异常
  const bl = new RemoteBlacklist(async () => { throw new Error('boom') })
  await bl.refresh()
  check('首次失败不抛异常', bl.matches('anything.com'), false)
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
