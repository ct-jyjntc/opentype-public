// 客户端 ↔ 服务器联调测试。
//
// 这是端到端一致性的最终证据：用客户端的真实代码
// （AuthService + SyncEngine）打真实服务器，验证协议完全对齐。
//
// 不是 mock 测试——mock 只能验证我以为的行为，真实联调才能暴露
// 序列化、字段名、响应结构上的不匹配。

import { AuthService } from '../src/main/services/auth.ts'
import { SyncEngine } from '../src/main/services/sync.ts'
import { randomUUID } from 'node:crypto'

const CLOUD = process.env.CLOUD_URL
if (!CLOUD) throw new Error('Run npm run test:integration to start an isolated local server')

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

// 内存版存储，模拟客户端的 electron-store
let stored = null

const auth = new AuthService({
  apiBaseUrl: CLOUD,
  webBaseUrl: CLOUD,
  appVersion: '0.1.0',
  load: async () => stored,
  save: async (u) => { stored = u }
})

// 内存版历史库，模拟本地 SQLite
const localRecords = new Map()
const syncedIds = new Set()
const failedIds = new Set()
let cloudEpoch = 0, pendingWipe = null
const excludedIds = new Set()

const sync = new SyncEngine({
  baseUrl: CLOUD,
  appVersion: '0.1.0',
  getToken: () => auth.getAccessToken(),
  getUserId: () => auth.userId,
  loadPendingRecords: async (_userId, limit) => {
    return [...localRecords.values()]
      .filter((r) => !syncedIds.has(r.id) && !failedIds.has(r.id) && !excludedIds.has(r.id))
      .slice(0, limit)
  },
  markSynced: async (ids) => { for (const id of ids) syncedIds.add(id) },
  markFailed: async (ids) => { for (const id of ids) failedIds.add(id) },
  applyRemote: async (records) => {
    for (const r of records) localRecords.set(r.id, r)
  },
  applyCloudEpoch: (_id,epoch) => { if(epoch>cloudEpoch){for(const id of localRecords.keys())excludedIds.add(id);cloudEpoch=epoch} },
  applyCloudEvictions: ids => { for(const id of ids)excludedIds.add(id) },
  beginCloudWipe:()=>pendingWipe??=randomUUID(),finishCloudWipe:()=>{pendingWipe=null},
})

console.log(`\n=== 联调目标: ${CLOUD} ===`)

// MARK: 连通性

console.log('\n=== 1. 服务器连通性 ===')
{
  const res = await fetch(`${CLOUD}/health`)
  const j = await res.json()
  check('服务器可达', res.status, 200)
  check('服务标识', j.service, 'opentype')
  check('隔离账号测试的 LLM 配置状态', j.upstreams.llm, process.env.EXPECT_LLM_CONFIGURED === '1')
}

// MARK: 账号

console.log('\n=== 2. 账号（密码注册登录）===')
const email = `e2e-${Date.now()}@opentype.dev`
const password = 'integration-test-password'

{
  // 用 AuthService 的公开接口测 PKCE 登录 URL 生成
  const url = new URL(auth.createLoginUrl('google'))
  check('登录 URL 指向服务器', url.origin, CLOUD)
  check('含 code_challenge', url.searchParams.has('code_challenge'), true)
  check('含 state', url.searchParams.has('state'), true)
}

{
  // 直接打注册端点（AuthService 未封装注册，这里验证协议对齐）
  const res = await fetch(`${CLOUD}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const j = await res.json()
  check('注册成功', j.status, 'OK')
  check('返回 access_token', typeof j.data?.access_token === 'string', true)

  // 写入 AuthService 的存储，模拟登录态
  await auth.initialize()
  stored = {
    user_id: j.data.user_id,
    email,
    access_token: j.data.access_token,
    refresh_token: j.data.refresh_token,
    expires_at: Date.now() + (j.data.expires_in ?? 3600) * 1000
  }
  // 重新加载
  await auth.initialize()
  check('AuthService 已登录', auth.isLoggedIn, true)
  check('userId 正确', auth.userId, j.data.user_id)
}

console.log('\n=== 2b. AuthService 密码注册登录（客户端真实方法）===')
{
  // 用 AuthService 自己的方法而非裸 fetch —— 验证客户端封装的正确性
  const e2 = `svc-${Date.now()}@opentype.dev`
  const pw = 'service-test-password'

  const reg = await auth.register(e2, pw)
  check('AuthService 注册成功', reg.success, true)
  check('注册后已登录', auth.isLoggedIn, true)

  await auth.logout()
  check('登出后未登录', auth.isLoggedIn, false)

  const login = await auth.loginWithPassword(e2, pw)
  check('AuthService 密码登录成功', login.success, true)
  check('登录后 userId 存在', typeof auth.userId === 'string', true)

  const wrong = await auth.loginWithPassword(e2, 'wrong-password')
  check('错误密码返回失败', wrong.success, false)
  check('错误码可读', wrong.detail, 'invalid_credentials')

  const dup = await auth.register(e2, 'another-password-long')
  check('重复注册返回失败', dup.success, false)
  check('重复注册错误码', dup.detail, 'email_exists')

  const weak = await auth.register(`w-${Date.now()}@x.dev`, 'short')
  check('弱密码返回失败', weak.success, false)
  check('弱密码错误码', weak.detail, 'password_too_short')
}

console.log('\n=== 3. token 刷新（AuthService 自动路径）===')
{
  const before = stored.refresh_token
  const ok = await auth.refresh()
  check('刷新成功', ok, true)
  check('refresh_token 已轮换', stored.refresh_token !== before, true)
  const token = await auth.getAccessToken()
  check('getAccessToken 可用', typeof token === 'string' && token.split('.').length === 3, true)
}

// MARK: 同步

console.log('\n=== 4. 推送（SyncEngine 真实路径）===')
{
  // 用真实 drizzle 形状的数据（camelCase），而不是手工 snake_case ——
  // 后者会掩盖「客户端发 camelCase、服务端读 snake_case」这类真实缺陷。
  // 这里模拟 db/index.ts 的 pendingSyncForApi 输出。
  localRecords.set('e2e-1', {
    id: 'e2e-1', status: 'completed', mode: 'voice_transcript',
    refined_text: '这是联调测试的第一条记录', created_at: new Date().toISOString()
  })
  localRecords.set('e2e-2', {
    id: 'e2e-2', status: 'completed', mode: 'voice_transcript',
    refined_text: '', created_at: new Date().toISOString()   // 空文本，应被拒
  })
  localRecords.set('e2e-3', {
    id: 'e2e-3', status: 'completed', mode: 'voice_command',
    refined_text: '外部动作', mode_meta: '{"ai_result":{"delivery":"external"}}',
    created_at: new Date().toISOString()
  })

  const result = await sync.pushNow()
  check('推送执行', result.pushed, 3)
  check('接受 2 条', result.accepted, 2)
  check('空文本记录已标记（避免重试）', syncedIds.has('e2e-2'), true)
  check('有效记录已标记', syncedIds.has('e2e-1'), true)

  // 关键回归：确认服务端真的收到了字段（而非收到 undefined）
  const status = await sync.getStatus()
  check('服务端确实存下了记录', status?.total, 2)
}

console.log('\n=== 4b. camelCase 不会被服务端接受（回归防护）===')
{
  // 直接推 camelCase 记录，服务端应全部拒绝——证明转换层是必需的
  const token = await auth.getAccessToken()
  const res = await fetch(`${CLOUD}/transcription_history/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      records: [{
        id: 'camel-test', status: 'completed', mode: 'voice_transcript',
        refinedText: 'camelCase 字段名', createdAt: new Date().toISOString()
      }]
    })
  })
  const j = await res.json()
  check('camelCase 记录被拒', j.data?.accepted?.length ?? 0, 0)
  check('拒绝原因为非候选', j.data?.rejected?.[0]?.reason, 'not_sync_candidate')
}

console.log('\n=== 5. 状态查询 ===')
{
  const status = await sync.getStatus()
  check('状态可查', status !== null, true)
  check('云端总数', status?.total, 2)
  check('保留期默认永久', status?.cloud_retention, -1)
}

console.log('\n=== 6. 拉取（SyncEngine 真实路径）===')
{
  // 清空本地模拟「新设备」
  localRecords.clear()
  const result = await sync.pull(0)
  check('拉取成功', result.applied, 2)
  check('本地已填充', localRecords.size, 2)
  const rec = localRecords.get('e2e-1')
  check('记录内容正确', rec?.refined_text, '这是联调测试的第一条记录')
}

console.log('\n=== 7. 分页 ===')
{
  const page = await sync.loadOlder(null, 1)
  check('分页返回', page !== null, true)
  check('首页 1 条', page?.records.length, 1)
  check('has_more 为真', page?.has_more, true)
}

console.log('\n=== 8. 保留期设置 ===')
{
  const s = await sync.updateSettings({ cloud_retention: 90 })
  check('保留期已更新', s?.cloud_retention, 90)
  check('生成 purge 时间', s?.purge_before_at !== null, true)
  // 恢复永久保留
  await sync.updateSettings({ cloud_retention: -1 })
}

console.log('\n=== 9. 会话代际隔离 ===')
{
  const genBefore = sync.currentGeneration
  sync.invalidateSession()
  check('代际已递增', sync.currentGeneration, genBefore + 1)
  check('旧代际失效', sync.isCurrentGeneration(genBefore), false)
  check('新代际有效', sync.isCurrentGeneration(sync.currentGeneration), true)
}

console.log('\n=== 10. 清空云端 ===')
{
  const ok = await sync.wipeCloud()
  check('清空成功', ok, true)
  const status = await sync.getStatus()
  check('清空后归零', status?.total, 0)
}

console.log('\n=== 11. 登出 ===')
{
  const refreshBefore = stored.refresh_token
  await auth.logout()
  check('已登出', auth.isLoggedIn, false)
  check('本地凭据已清', stored, null)

  // 登出后刷新应失败
  const res = await fetch(`${CLOUD}/oauth/refresh_access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshBefore })
  })
  const j = await res.json()
  check('登出后 refresh 失效', j.status, 'ERROR')
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
