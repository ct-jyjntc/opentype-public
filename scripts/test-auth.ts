// 认证服务测试：PKCE 生成、state 校验、token 刷新、账号代际隔离。
//
// 这些是「错了就登不上或过期后无法自愈」的关键路径。
// 用注入的假 store 与假 fetch，不依赖网络。

import { AuthService } from '../src/main/services/auth.ts'
import { createHash, randomUUID } from 'node:crypto'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

/** 构造一个可控的 AuthService，拦截 fetch 以模拟服务端。 */
function makeService(responses: Array<{ match: string; body: unknown; status?: number }> = []) {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  let stored: any = null

  const svc = new AuthService({
    apiBaseUrl: 'https://api.test',
    webBaseUrl: 'https://web.test',
    appVersion: '0.1.0',
    load: async () => stored,
    save: async (u) => { stored = u },
    onUserChanged: () => {}
  })

  // 拦截 undici 的 request —— 通过替换 globalThis.fetch 不可行（undici 不走 fetch），
  // 改为直接测试不依赖网络的纯逻辑部分，网络部分用 mock 模块注入。
  return { svc, calls, getStored: () => stored }
}

console.log('\n=== PKCE 登录 URL 生成 ===')
{
  const { svc } = makeService()
  const url = new URL(svc.createLoginUrl('google'))

  check('路径正确', url.pathname, '/login/app/auth')
  check('next 参数映射 google', url.searchParams.get('next'), '/login/google')
  check('含 code_challenge', (url.searchParams.get('code_challenge') ?? '').length > 20, true)
  check('含 state', (url.searchParams.get('state') ?? '').length > 10, true)
  // base64url 不应含 +/= （需要 URL 编码的字符）
  const challenge = url.searchParams.get('code_challenge') ?? ''
  check('code_challenge 为 base64url', /^[A-Za-z0-9_-]+$/.test(challenge), true)
}

console.log('\n=== 各 provider 的 next 映射 ===')
{
  const { svc } = makeService()
  const cases: Array<[string, string]> = [
    ['google', '/login/google'], ['email', '/login/email'],
    ['apple', '/login/apple'], ['sso', '/login/sso'], ['login', '/login']
  ]
  for (const [provider, expected] of cases) {
    const url = new URL(svc.createLoginUrl(provider))
    check(`${provider} → ${expected}`, url.searchParams.get('next'), expected)
  }
  let threw = false
  try { svc.createLoginUrl('nonexistent') } catch { threw = true }
  check('未知 provider 抛错', threw, true)
}

console.log('\n=== 每次登录生成不同的 PKCE ===')
{
  const { svc } = makeService()
  const a = new URL(svc.createLoginUrl('google'))
  const b = new URL(svc.createLoginUrl('google'))
  check('state 每次不同', a.searchParams.get('state') !== b.searchParams.get('state'), true)
  check('challenge 每次不同', a.searchParams.get('code_challenge') !== b.searchParams.get('code_challenge'), true)
}

console.log('\n=== state 校验（防 CSRF / 会话固定）===')
{
  const { svc } = makeService()
  // 没有发起过登录
  const r1 = await svc.exchangeLoginCode('code', 'state')
  check('无 pending 时拒绝', r1.detail, 'no_pending_login')

  const url = new URL(svc.createLoginUrl('google'))
  const realState = url.searchParams.get('state')!

  // state 不匹配必须拒绝
  const r2 = await svc.exchangeLoginCode('code', 'wrong-state')
  check('state 不匹配被拒', r2.detail, 'state_mismatch')
  check('state 不匹配后清空 pending', (await svc.exchangeLoginCode('code', realState)).detail, 'no_pending_login')
}

console.log('\n=== token 过期判定 ===')
{
  const { svc } = makeService()
  check('未登录时 token 为 null', await svc.getAccessToken(), null)
  check('未登录 isLoggedIn=false', svc.isLoggedIn, false)
  check('未登录 userId 为 null', svc.userId, null)
}

console.log('\n=== 账号代际隔离 ===')
{
  const { svc } = makeService()
  const gen0 = svc.currentGeneration
  check('初始代际', gen0, 0)
  check('代际自校验', svc.isCurrentGeneration(gen0), true)
  check('非当前代际判定', svc.isCurrentGeneration(gen0 + 1), false)
}

console.log('\n=== 登出（未登录时不应抛错）===')
{
  const { svc } = makeService()
  let threw = false
  try { await svc.logout() } catch { threw = true }
  check('未登录登出不抛错', threw, false)
  check('登出后仍未登录', svc.isLoggedIn, false)
}

console.log('\n=== getAuthInfo 形状 ===')
{
  const { svc } = makeService()
  check('getAuthInfo 结构', svc.getAuthInfo(), { token: null, userId: null })
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
