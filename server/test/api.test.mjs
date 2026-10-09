// OpenType 后端端到端测试。
//
// 覆盖全部协议契约：账号、PKCE、令牌轮换、同步、过滤规则、错误处理。
// 这些是端到端一致性的可执行证据——协议错了客户端会直接失效。
//
// 启动真实服务进程测试，不 mock —— mock 只能验证我以为的行为，
// 真实进程才能暴露路由注册、序列化、SQL 层面的问题。

import { spawn } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'

const PORT = 19200
const DB = '/tmp/opentype_test.db'
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

// 清理旧数据并启动服务
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  if (existsSync(f)) rmSync(f)
}

// 测试脚本位于 server/test/，其父目录即 server 根
const serverDir = new URL('..', import.meta.url).pathname
// 用 process.execPath 而非 'node'：后者依赖 PATH，在某些环境下找不到
const proc = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
  cwd: serverDir,
  env: { ...process.env, DB_PATH: DB, PORT: String(PORT), JWT_SECRET: 'test-secret', NODE_ENV: 'development', MAIL_API_URL: '', MAIL_API_KEY: '', MAIL_FROM: '' },
  stdio: 'ignore'
})

// 等端口就绪
await new Promise((resolve) => {
  const tick = (n) => {
    fetch(`${BASE}/health`).then(resolve).catch(() => n > 0 ? setTimeout(() => tick(n - 1), 200) : resolve())
  }
  setTimeout(() => tick(30), 400)
})

const cleanup = () => { proc.kill(); for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f) } catch {} } }
process.on('exit', cleanup)

// MARK: 健康检查

console.log('\n=== 健康检查 ===')
{
  const r = await fetch(`${BASE}/health`).then((x) => x.json())
  check('服务标识', r.service, 'opentype')
  check('状态正常', r.status, 'ok')
}

// MARK: 账号体系

console.log('\n=== 账号体系 ===')
const email = `test-${Date.now()}@opentype.dev`
let token, refreshToken, userId

{
  const r = await api('POST', '/oauth/signin_with_email', { body: { email } })
  check('请求验证码', r.status, 'OK')
  check('返回需要验证', r.data.requires_verification, true)
  check('开发环境返回验证码', typeof r.data.dev_code === 'string' && r.data.dev_code.length === 6, true)

  const v = await api('POST', '/oauth/verify_secret_code', { body: { email, code: r.data.dev_code } })
  check('验证码登录成功', v.status, 'OK')
  check('返回 access_token', typeof v.data.access_token === 'string' && v.data.access_token.split('.').length === 3, true)
  check('返回 refresh_token', typeof v.data.refresh_token === 'string' && v.data.refresh_token.length > 30, true)
  check('返回 user_id', typeof v.data.user_id === 'string' && v.data.user_id.length === 36, true)
  token = v.data.access_token
  refreshToken = v.data.refresh_token
  userId = v.data.user_id
}

{
  const r = await api('POST', '/oauth/signin_with_email', { body: {} })
  check('缺邮箱被拒', r.status, 'ERROR')
}

{
  const r = await api('POST', '/oauth/verify_secret_code', { body: { email, code: '000000' } })
  check('错误验证码被拒', r.status, 'ERROR')
}

console.log('\n=== 密码注册与登录 ===')
{
  const pwdEmail = `pwd-${Date.now()}@opentype.dev`
  const r = await api('POST', '/oauth/register', { body: { email: pwdEmail, password: 'test-password-123' } })
  check('注册成功', r.status, 'OK')
  check('返回 token', r.data.access_token.split('.').length, 3)
  check('返回 user_id', typeof r.data.user_id === 'string', true)

  // 用足够长的密码测重复邮箱——校验顺序是先格式/长度后唯一性
  const dup = await api('POST', '/oauth/register', { body: { email: pwdEmail, password: 'another-valid-password' } })
  check('重复邮箱被拒', dup.detail, 'email_exists')

  const weak = await api('POST', '/oauth/register', { body: { email: `w-${Date.now()}@x.dev`, password: 'short' } })
  check('弱密码被拒', weak.detail, 'password_too_short')

  const bad = await api('POST', '/oauth/register', { body: { email: 'not-an-email', password: 'longenough123' } })
  check('非法邮箱被拒', bad.detail, 'invalid_email')

  const login = await api('POST', '/oauth/login', { body: { email: pwdEmail, password: 'test-password-123' } })
  check('密码登录成功', login.status, 'OK')

  const wrong = await api('POST', '/oauth/login', { body: { email: pwdEmail, password: 'wrong-password' } })
  check('错误密码被拒', wrong.detail, 'invalid_credentials')
}

console.log('\n=== 鉴权 ===')
{
  const r = await api('POST', '/transcription_history/sync_status', { body: {} })
  check('无 token 被拒', r.status, 'ERROR')
  check('返回 401 语义', r.code, 401)
}
{
  const r = await api('POST', '/transcription_history/sync_status', { body: {}, token: 'bogus.token.here' })
  check('伪造 token 被拒', r.status, 'ERROR')
}
{
  const r = await api('GET', '/user/get_user_info', { token })
  check('有效 token 通过', r.status, 'OK')
  check('返回用户 id', r.data.user_id, userId)
  check('含 rsa_public_key 字段', 'rsa_public_key' in r.data, true)
}

// MARK: 同步

console.log('\n=== 历史同步 ===')
{
  const r = await api('POST', '/transcription_history/push', {
    token,
    body: {
      records: [
        { id: 'r1', status: 'completed', mode: 'voice_transcript', refined_text: '有效记录', created_at: '2026-10-05T12:00:00Z' },
        { id: 'r2', status: 'completed', mode: 'voice_transcript', refined_text: '', created_at: '2026-10-05T12:01:00Z' },
        { id: 'r3', status: 'failed', mode: 'voice_transcript', refined_text: '失败记录', created_at: '2026-10-05T12:02:00Z' },
        { id: 'r4', status: 'completed', mode: 'voice_command', refined_text: '外部动作', mode_meta: '{"ai_result":{"delivery":"external"}}', created_at: '2026-10-05T12:03:00Z' },
        // r5 同时满足「文本为空」且「命令未外发」→ 唯一应被拒的 completed 记录。
        // 这条专门测 SQL 的第二个分支：mode=voice_command AND delivery='external'。
        { id: 'r5', status: 'completed', mode: 'voice_command', refined_text: '', mode_meta: '{"ai_result":{"delivery":"inline"}}', created_at: '2026-10-05T12:04:00Z' }
      ]
    }
  })
  check('推送成功', r.status, 'OK')
  // 过滤规则：空转写、失败记录、无 external 的命令都不该同步
  check('接受的记录', r.data.accepted.sort(), ['r1', 'r4'])
  check('拒绝数', r.data.rejected.length, 3)
  // 过滤规则：status='completed' AND (文本非空 OR 命令已外发)
  check('r5 因文本为空且未外发被拒', r.data.rejected.some((x) => x.id === 'r5'), true)
  check('拒绝原因正确', r.data.rejected.every((x) => x.reason === 'not_sync_candidate'), true)
}

{
  const r = await api('POST', '/transcription_history/sync_status', { token, body: {} })
  check('状态总数', r.data.total, 2)
  check('保留期默认永久', r.data.cloud_retention, -1)
  check('同步默认开启', r.data.sync_enabled, true)
}

{
  const r = await api('POST', '/transcription_history/pull', { token, body: { since: 0 } })
  check('拉取记录数', r.data.records.length, 2)
  check('含游标', typeof r.data.cursor === 'number' && r.data.cursor > 0, true)
  check('has_more 正确', r.data.has_more, false)
  check('返回 refined_text', r.data.records.every((x) => typeof x.refined_text === 'string'), true)
}

console.log('\n=== 幂等性 ===')
{
  await api('POST', '/transcription_history/push', {
    token, body: { records: [{ id: 'r1', status: 'completed', mode: 'voice_transcript', refined_text: '已修改' }] }
  })
  const s = await api('POST', '/transcription_history/sync_status', { token, body: {} })
  check('重复推送不增总数', s.data.total, 2)
  const p = await api('POST', '/transcription_history/pull', { token, body: { since: 0 } })
  const r1 = p.data.records.find((x) => x.id === 'r1')
  check('内容已更新', r1.refined_text, '已修改')
}

console.log('\n=== 分页 ===')
{
  const r = await api('POST', '/transcription_history/load_older', { token, body: { before: null, limit: 1 } })
  check('首页返回 1 条', r.data.records.length, 1)
  check('has_more 为真', r.data.has_more, true)
}

console.log('\n=== 保留期 ===')
{
  const r = await api('POST', '/transcription_history/sync_settings', { token, body: { cloud_retention: 30 } })
  check('保留期已设', r.data.cloud_retention, 30)
  check('生成 purge_before_at', r.data.purge_before_at !== null, true)
}

console.log('\n=== 令牌轮换 ===')
{
  const r = await api('POST', '/oauth/refresh_access_token', { body: { refresh_token: refreshToken } })
  check('刷新成功', r.status, 'OK')
  check('refresh_token 已轮换', r.data.refresh_token !== refreshToken, true)
  check('新 access_token 形状正确', r.data.access_token.split('.').length, 3)

  const reuse = await api('POST', '/oauth/refresh_access_token', { body: { refresh_token: refreshToken } })
  check('旧令牌复用被拒', reuse.status, 'ERROR')

  token = r.data.access_token
  refreshToken = r.data.refresh_token
}

console.log('\n=== 授权页（客户端登录入口）===')
{
  // GET 应返回登录表单
  const r = await fetch(`${BASE}/login/app/auth?code_challenge=CH&state=ST&next=/login/email`)
  const html = await r.text()
  check('授权页 200', r.status, 200)
  check('含登录标题', html.includes('登录 OpenType'), true)
  check('透传 code_challenge', html.includes('value="CH"'), true)
  check('透传 state', html.includes('value="ST"'), true)
  check('透传 next', html.includes('value="/login/email"'), true)
  check('无缓存头', r.headers.get('cache-control'), 'no-store')

  // 缺参数应提示错误
  const bad = await fetch(`${BASE}/login/app/auth`)
  const badHtml = await bad.text()
  check('缺参数提示错误', badHtml.includes('缺少'), true)

  // 模式切换必须是 GET 链接，不能是 POST 表单。
  // 曾经的 bug：POST 空邮箱触发「邮箱格式不正确」，用户还没填就报错。
  check('模式切换用 GET 链接', html.includes('href="/login/app/auth?'), true)
  check('模式切换不用 POST 表单', !/mode" value="(login|register)" \/>\s*<button type="submit" class="link"/.test(html), true)
  // 注意：上面的 html 是不带 mode 的默认（登录）页，它应含「去注册」链接。
  // 注册页的「去登录」链接在下面的切换测试里验证。
  check('登录页含去注册链接', html.includes('没有账号'), true)

  // 切换模式的 GET 请求应正常返回，不报邮箱错误
  const sw = await fetch(`${BASE}/login/app/auth?code_challenge=CH&state=ST&next=/login/email&mode=register`)
  const swHtml = await sw.text()
  check('切换模式页 200', sw.status, 200)
  check('切换模式页无邮箱错误', swHtml.includes('邮箱格式不正确'), false)
  check('切换模式页显示注册标题', swHtml.includes('创建账号'), true)
  check('注册页含去登录链接', swHtml.includes('已有账号'), true)
}

{
  // POST 注册 → 重定向到深链接
  const verifier = randomUUID() + randomUUID()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomUUID()
  const email = `page-${Date.now()}@opentype.dev`

  const form = new URLSearchParams({
    email, password: 'page-test-password', code_challenge: challenge,
    state, next: '/login/email', mode: 'register'
  })
  const r = await fetch(`${BASE}/login/app/auth`, {
    method: 'POST', body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual'
  })
  check('注册后重定向', r.status, 302)
  const loc = r.headers.get('location') ?? ''
  check('重定向到深链接', loc.startsWith('opentype://auth/callback?'), true)
  check('深链接含 code', loc.includes('code='), true)

  // 从深链接提取 code 并兑换
  const code = new URLSearchParams(loc.split('?')[1]).get('code')
  const ex = await api('POST', '/oauth/exchange_app_login_code', {
    body: { code, code_verifier: verifier, state }
  })
  check('授权码可兑换', ex.status, 'OK')
  check('返回 access_token', ex.data.access_token.split('.').length, 3)

  // 错误密码
  const badForm = new URLSearchParams({
    email, password: 'wrong', code_challenge: challenge, state, mode: 'login'
  })
  const bad = await fetch(`${BASE}/login/app/auth`, {
    method: 'POST', body: badForm,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
  const badHtml = await bad.text()
  check('错误密码被拒', badHtml.includes('邮箱或密码不正确'), true)

  // 重复注册
  const dupForm = new URLSearchParams({
    email, password: 'another-password', code_challenge: challenge, state, mode: 'register'
  })
  const dup = await fetch(`${BASE}/login/app/auth`, {
    method: 'POST', body: dupForm,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
  const dupHtml = await dup.text()
  check('重复注册被拒', dupHtml.includes('已注册'), true)
}

console.log('\n=== PKCE 闭环 ===')
{
  const verifier = randomUUID() + randomUUID()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomUUID()

  const a = await api('POST', '/oauth/authorize', { token, body: { code_challenge: challenge, state } })
  check('签发授权码', a.status, 'OK')
  const code = a.data.code

  const e = await api('POST', '/oauth/exchange_app_login_code', { body: { code, code_verifier: verifier, state } })
  check('兑换成功', e.status, 'OK')
  check('返回新 token', e.data.access_token.split('.').length, 3)

  const replay = await api('POST', '/oauth/exchange_app_login_code', { body: { code, code_verifier: verifier, state } })
  check('重放被拒', replay.detail, 'code_already_used')

  // 错误 verifier
  const a2 = await api('POST', '/oauth/authorize', { token, body: { code_challenge: challenge, state } })
  const bad = await api('POST', '/oauth/exchange_app_login_code', {
    body: { code: a2.data.code, code_verifier: 'wrong', state }
  })
  check('错误 verifier 被拒', bad.detail, 'pkce_verification_failed')

  // state 不匹配
  const a3 = await api('POST', '/oauth/authorize', { token, body: { code_challenge: challenge, state } })
  const badState = await api('POST', '/oauth/exchange_app_login_code', {
    body: { code: a3.data.code, code_verifier: verifier, state: 'wrong-state' }
  })
  check('state 不匹配被拒', badState.detail, 'state_mismatch')
}

console.log('\n=== 其他端点 ===')
{
  const b = await api('POST', '/app/get_blacklist_domain', { body: {} })
  check('黑名单端点', b.status, 'OK')
  check('返回数组', Array.isArray(b.data.data), true)
}
{
  const o = await api('POST', '/user/update_onboarding', { token, body: {} })
  check('onboarding 端点', o.status, 'OK')
}
{
  const h = await api('POST', '/transcription_history/acknowledge_hints', { token, body: { hints: ['a', 'b'] } })
  check('确认提示', h.status, 'OK')
  check('回显已确认', h.data.acknowledged, ['a', 'b'])
}

console.log('\n=== 清空 ===')
{
  const invalid = await api('POST', '/transcription_history/wipe', { token, body: {} })
  check('清空必须带幂等请求编号', invalid.detail, 'invalid_wipe_request')
  const w = await api('POST', '/transcription_history/wipe', { token, body: { request_id: 'api-test-wipe' } })
  check('清空返回删除数', w.data.deleted, 2)
  check('清空推进云端代际', w.data.cloud_epoch, 1)
  const s = await api('POST', '/transcription_history/sync_status', { token, body: {} })
  check('清空后总数归零', s.data.total, 0)
}

console.log('\n=== 语音端点（纯文本润色路径）===')
{
  // 无 LLM 配置时，润色降级返回原文。这里验证端点本身可用。
  const form = new FormData()
  form.append('text', '嗯那个我们今天下午三点开会')
  form.append('mode', 'voice_transcript')
  const res = await fetch(`${BASE}/ai/voice_flow`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  const j = await res.json()
  check('文本润色端点可用', j.status, 'OK')
  check('返回 refine_text', typeof j.data?.refine_text === 'string', true)
  check('返回 raw_text', j.data?.raw_text, '嗯那个我们今天下午三点开会')
}
{
  // 既无音频也无文本 → 400
  const form = new FormData()
  form.append('mode', 'voice_transcript')
  const res = await fetch(`${BASE}/ai/voice_flow`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  const j = await res.json()
  check('缺音频与文本被拒', j.detail, 'audio_file_or_text_required')
}

console.log('\n=== 帮助页面 ===')
{
  // 前端用 <iframe src=".../help/release-notes/macos?..."> 加载，不带 Authorization 头。
  // 这两个断言正是「不带 token 也要能拿到页面」——若走鉴权，iframe 里只会渲染 401 JSON。
  const r = await fetch(`${BASE}/help/release-notes/macos?noHeader=1&noFooter=1&noTitle=1&lang=zh-CN`)
  const html = await r.text()
  check('更新说明页 200', r.status, 200)
  check('更新说明页是 HTML', r.headers.get('content-type')?.includes('text/html'), true)
  check('更新说明页含版本号', html.includes('0.1.0'), true)
  check('noTitle=1 时不渲染标题', html.includes('<h1>'), false)

  // 中文 lang 必须出中文文案，否则 iframe 里会出现中英混排
  check('中文 lang 出中文', html.includes('更新说明'), true)

  const en = await (await fetch(`${BASE}/help/release-notes/windows?lang=en`)).text()
  check('英文 lang 出英文', en.includes('Release Notes'), true)
  // 不带 noTitle 时应渲染标题
  check('默认渲染标题', en.includes('<h1>'), true)

  // 动态段：windows 平台名要原样带出，不能被写死成 macos
  check('平台名透传', en.includes('windows'), true)

  const mic = await fetch(`${BASE}/help/troubleshooting/microphone-unavailable?lang=zh-CN`)
  const micHtml = await mic.text()
  check('麦克风排障页 200', mic.status, 200)
  check('排障页含步骤', micHtml.includes('系统设置'), true)

  // 前缀豁免不能顺手把 /health 之类的精确路由打穿
  const health = await fetch(`${BASE}/health`)
  check('health 仍免鉴权', health.status, 200)
  // 带 :param 的模板不应误匹配到其他路径
  const bogus = await fetch(`${BASE}/help/`)
  check('未知 help 子路径 404', bogus.status, 404)
}

console.log('\n=== 法律与联系页面 ===')
{
  // 渲染层「关于」与登录授权页的链接指向这三个路径（target=_blank，无鉴权头）
  for (const name of ['privacy', 'terms', 'contact']) {
    const r = await fetch(`${BASE}/${name}?lang=zh-CN`)
    const html = await r.text()
    check(`${name} 200`, r.status, 200)
    check(`${name} 是 HTML`, r.headers.get('content-type')?.includes('text/html'), true)
    check(`${name} 免鉴权（非 401 JSON）`, !html.startsWith('{'), true)
  }
  const privacyZh = await (await fetch(`${BASE}/privacy?lang=zh-CN`)).text()
  check('隐私政策中文', privacyZh.includes('隐私政策'), true)
  const privacyEn = await (await fetch(`${BASE}/privacy?lang=en`)).text()
  check('隐私政策英文', privacyEn.includes('Privacy Policy'), true)
  // 隐私承诺必须与产品实际一致：不存音频、不训练模型
  check('隐私政策含不存音频承诺', privacyZh.includes('不在云端存储原始音频'), true)
}

console.log('\n=== 错误处理 ===')
{
  const r = await fetch(`${BASE}/nonexistent`, { method: 'POST' })
  check('未知路由 404', r.status, 404)
}
{
  const r = await api('POST', '/transcription_history/push', { token, body: {} })
  check('缺 records 被拒', r.status, 'ERROR')
}

// MARK: 用户信息形状（渲染层首页依赖）

console.log('\n=== 用户信息字段（A1）===')
{
  const r = await api('GET', '/user/get_user_info', { token })
  check('roles 是数组', Array.isArray(r.data.roles), true)
  // 全功能免费：人人持有未过期的 pro 角色
  check('roles 含永不过期 pro', r.data.roles.some((role) => role.name === 'pro' && role.exp_time > Date.now()), true)
  check('is_new_user 为 false', r.data.is_new_user, false)
  check('translation_settings 带 target_languages', Array.isArray(r.data.translation_settings?.target_languages), true)
  check('locale 默认 null', r.data.locale, null)
  check('subscription_type 非企业', r.data.subscription_type, 'FREE')
  check('subscription_plan_name 是 PRO_YEARLY', r.data.subscription_plan_name, 'PRO_YEARLY')
  check('org_settings 默认 null', r.data.org_settings, null)
}

// MARK: 词典

console.log('\n=== 词典（A2）===')
{
  const noAuth = await api('GET', '/user/dictionary/list')
  check('词典无 token 被拒', noAuth.status, 'ERROR')
  check('词典 401 语义', noAuth.code, 401)

  const a1 = await api('POST', '/user/dictionary/add', { token, body: { term: '朝闻道' } })
  check('加词成功', a1.status, 'OK')
  check('返回词 id', typeof a1.data.user_dictionary_id, 'string')
  check('返回 term', a1.data.term, '朝闻道')
  check('auto 是布尔 false', a1.data.auto, false)
  const id1 = a1.data.user_dictionary_id

  const a2 = await api('POST', '/user/dictionary/add', { token, body: { term: '夕死可矣' } })
  const id2 = a2.data.user_dictionary_id

  const dup = await api('POST', '/user/dictionary/add', { token, body: { term: '朝闻道' } })
  check('重复词被拒', dup.detail, 'word_exists')

  const empty = await api('POST', '/user/dictionary/add', { token, body: { term: '   ' } })
  check('空词被拒', empty.detail, 'invalid_term')

  const long = await api('POST', '/user/dictionary/add', { token, body: { term: 'x'.repeat(101) } })
  check('超长词被拒', long.detail, 'invalid_term')

  const l = await api('GET', '/user/dictionary/list?offset=0&size=10', { token })
  check('列表返回总数', l.data.total_count, 2)
  check('列表返回词', l.data.words.length, 2)
  check('词形状含 term', l.data.words.every((w) => typeof w.term === 'string'), true)

  const p = await api('GET', '/user/dictionary/list?offset=0&size=1', { token })
  check('分页 size=1', p.data.words.length, 1)
  check('分页总数不变', p.data.total_count, 2)
  const p2 = await api('GET', '/user/dictionary/list?offset=1&size=1', { token })
  check('第二页词不同', p2.data.words[0].user_dictionary_id !== p.data.words[0].user_dictionary_id, true)

  const q = await api('GET', `/user/dictionary/list?query=${encodeURIComponent('夕死')}`, { token })
  check('搜索过滤', q.data.words.length, 1)
  check('搜索结果正确', q.data.words[0].term, '夕死可矣')

  const af = await api('GET', '/user/dictionary/list?auto=true', { token })
  check('auto 过滤（无自动词）', af.data.words.length, 0)

  const u = await api('POST', '/user/dictionary/update', { token, body: { user_dictionary_id: id1, term: '朝闻道也' } })
  check('改词成功', u.data.term, '朝闻道也')
  const u404 = await api('POST', '/user/dictionary/update', { token, body: { user_dictionary_id: 'nope', term: 'x' } })
  check('改不存在的词 404', u404.detail, 'word_not_found')
  const udup = await api('POST', '/user/dictionary/update', { token, body: { user_dictionary_id: id1, term: '夕死可矣' } })
  check('改成已有词被拒', udup.detail, 'word_exists')

  // 批量导入：先去重预览，再导入，再验证幂等
  const pv = await api('POST', '/user/dictionary/bulk-import/preview', {
    token, body: { content: '新词甲\n新词乙\n朝闻道也\n新词甲\n' }
  })
  check('预览返回 results', Array.isArray(pv.data.results), true)
  check('预览行号', pv.data.results[0].line, 1)
  check('预览新词 ready', pv.data.results[0].status, 'ready')
  check('预览已有词 duplicate', pv.data.results[2].status, 'duplicate')
  check('预览文件内重复 duplicate', pv.data.results[3].status, 'duplicate')

  const bi = await api('POST', '/user/dictionary/bulk-import', { token, body: { content: '新词甲\n新词乙\n朝闻道也\n新词甲' } })
  check('导入成功', bi.status, 'OK')
  check('导入计数', bi.data.imported_count, 2)
  check('跳过计数', bi.data.skipped_count, 2)

  const bi2 = await api('POST', '/user/dictionary/bulk-import', { token, body: { content: '新词甲\n新词乙' } })
  check('重复导入幂等（全跳过）', bi2.data.imported_count, 0)
  check('重复导入计入跳过', bi2.data.skipped_count, 2)

  const la = await api('GET', '/user/dictionary/list?offset=0&size=50', { token })
  check('导入后总数', la.data.total_count, 4)

  const d = await api('POST', '/user/dictionary/delete', { token, body: { user_dictionary_id: id2 } })
  check('删词成功', d.status, 'OK')
  const dAgain = await api('POST', '/user/dictionary/delete', { token, body: { user_dictionary_id: id2 } })
  check('重复删除幂等', dAgain.status, 'OK')

  const bd = await api('POST', '/user/dictionary/batch-delete', { token, body: { user_dictionary_ids: [id1] } })
  check('批量删除计数', bd.data.deleted_count, 1)
  const bdEmpty = await api('POST', '/user/dictionary/batch-delete', { token, body: { user_dictionary_ids: [] } })
  check('空批量删除被拒', bdEmpty.status, 'ERROR')

  const lr = await api('GET', '/user/dictionary/list?offset=0&size=50', { token })
  check('删除后剩余', lr.data.total_count, 2)
}

// MARK: 密码重置

console.log('\n=== 密码重置（A3）===')
{
  const resetEmail = `reset-${Date.now()}@opentype.dev`
  const reg = await api('POST', '/oauth/register', { body: { email: resetEmail, password: 'old-password-1' } })
  check('注册成功', reg.status, 'OK')
  const oldRefresh = reg.data.refresh_token

  const req1 = await api('POST', '/oauth/request_password_reset', { body: { email: resetEmail } })
  check('请求重置成功', req1.status, 'OK')
  check('开发环境返回重置码', typeof req1.data.dev_code, 'string')
  const resetCode = req1.data.dev_code

  // 防枚举：未注册邮箱得到同样的 OK 形状（仅 dev_code 缺省，生产无此字段）
  const req2 = await api('POST', '/oauth/request_password_reset', { body: { email: `ghost-${Date.now()}@opentype.dev` } })
  check('未注册邮箱同样 OK', req2.status, 'OK')
  check('未注册邮箱同形状', req2.data.success, true)
  check('未注册邮箱无 dev_code', 'dev_code' in req2.data, false)

  const weak = await api('POST', '/oauth/reset_password', { body: { email: resetEmail, code: resetCode, new_password: 'short' } })
  check('弱密码被拒', weak.detail, 'password_too_short')

  const wrong = await api('POST', '/oauth/reset_password', { body: { email: resetEmail, code: '000000', new_password: 'new-password-9' } })
  check('错误重置码被拒', wrong.detail, 'invalid_code')

  const ok = await api('POST', '/oauth/reset_password', { body: { email: resetEmail, code: resetCode, new_password: 'new-password-9' } })
  check('重置成功', ok.status, 'OK')

  const replay = await api('POST', '/oauth/reset_password', { body: { email: resetEmail, code: resetCode, new_password: 'new-password-9' } })
  check('重置码一次性', replay.detail, 'code_already_used')

  const oldLogin = await api('POST', '/oauth/login', { body: { email: resetEmail, password: 'old-password-1' } })
  check('旧密码失效', oldLogin.detail, 'invalid_credentials')
  const newLogin = await api('POST', '/oauth/login', { body: { email: resetEmail, password: 'new-password-9' } })
  check('新密码可登录', newLogin.status, 'OK')

  const staleRefresh = await api('POST', '/oauth/refresh_access_token', { body: { refresh_token: oldRefresh } })
  check('重置后旧 refresh token 失效', staleRefresh.detail, 'invalid_refresh_token')

  // 重置不建号：对未注册邮箱直接用猜的码重置
  const noUser = await api('POST', '/oauth/reset_password', { body: { email: `nouser-${Date.now()}@opentype.dev`, code: '123456', new_password: 'new-password-9' } })
  check('未发码邮箱被拒', noUser.detail, 'no_code_issued')

  // 错码限次：独立 IP 申请新码，连错 5 次后第 6 次拒绝
  const limitEmail = `limit-${Date.now()}@opentype.dev`
  await api('POST', '/oauth/register', { body: { email: limitEmail, password: 'limit-password-1' } })
  const rl = await fetch(`${BASE}/oauth/request_password_reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.66.0.1' },
    body: JSON.stringify({ email: limitEmail })
  }).then((x) => x.json())
  const limitCode = rl.data.dev_code
  for (let i = 0; i < 5; i++) {
    await api('POST', '/oauth/reset_password', { body: { email: limitEmail, code: '999999', new_password: 'whatever-123' } })
  }
  const sixth = await api('POST', '/oauth/reset_password', { body: { email: limitEmail, code: limitCode, new_password: 'whatever-123' } })
  check('错码 5 次后锁定', sixth.detail, 'too_many_attempts')

  // 请求频率限制：同一 IP 1 小时内最多 5 次
  let last
  for (let i = 0; i < 6; i++) {
    last = await fetch(`${BASE}/oauth/request_password_reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.66.0.2' },
      body: JSON.stringify({ email: limitEmail })
    }).then((x) => x.json())
  }
  check('第 6 次请求被限流', last.detail, 'rate_limited')
}

// MARK: 首页/设置端点

console.log('\n=== 首页与设置端点（A4）===')
{
  const us = await api('POST', '/user/usage_stats', { token, body: {} })
  check('usage_stats 形状', typeof us.data.voice_transcription?.total_words, 'number')

  const ps = await api('POST', '/user/personal_stats', { token, body: {} })
  check('personal_stats 默认未开启', ps.data.enabled, false)
  check('personal_stats 空类别', Array.isArray(ps.data.category_stats), true)

  const ins = await api('POST', '/user/insights', { token, body: { start_date: 0, end_date: 9999999999 } })
  check('insights 空热力图', Array.isArray(ins.data.heatmap?.days), true)
  check('insights has_more_before', ins.data.heatmap.has_more_before, false)
  // 分享页直接读 summary.active_days，缺了 summary 会白屏
  check('insights 含 summary', typeof ins.data.summary?.active_days === 'number'
    && typeof ins.data.summary?.current_streak === 'number'
    && typeof ins.data.summary?.longest_streak === 'number', true)

  // 推一条记录后统计应为真值
  await api('POST', '/transcription_history/push', {
    token,
    body: { cloud_epoch: 1, records: [{ id: 'stats-test-1', status: 'completed', mode: 'voice_transcript', refined_text: '今天天气不错 hello world', duration: 3 }] }
  })
  const ins2 = await api('POST', '/user/insights', { token, body: { start_date: 0, end_date: 9999999999 } })
  check('有记录后 active_days≥1', ins2.data.summary.active_days >= 1, true)
  check('有记录后 heatmap 有当天', ins2.data.heatmap.days.some((d) => d.level >= 1), true)
  const us2 = await api('POST', '/user/usage_stats', { token, body: {} })
  check('usage_stats 字数为真', us2.data.voice_transcription.total_words >= 6, true)
  check('usage_stats 含分钟与语速', typeof us2.data.voice_transcription.mins_saved === 'number'
    && typeof us2.data.voice_transcription.avg_wpm === 'number', true)

  const bn = await api('POST', '/app/get_free_quota_notice_banner_config', { token, body: {} })
  check('横幅默认关闭', bn.data.banner_enabled, false)

  const ds = await api('GET', '/user/get_dictation_settings', { token })
  check('听写设置默认空映射', JSON.stringify(ds.data.dictation_settings?.output_language_map), '{}')

  const sds = await api('POST', '/user/set_dictation_settings', { token, body: { output_language_map: { en: 'zh-CN' } } })
  check('写听写设置', sds.status, 'OK')
  const ds2 = await api('GET', '/user/get_dictation_settings', { token })
  check('听写设置回读', ds2.data.dictation_settings.output_language_map.en, 'zh-CN')

  const up = await api('POST', '/user/update_settings', {
    token, body: { 'translation_settings.target_languages': ['en'], 'user_info.locale': 'zh-CN', personal_auto_style_on: true }
  })
  check('更新设置', up.status, 'OK')
  const ui = await api('GET', '/user/get_user_info', { token })
  check('target_languages 回读', JSON.stringify(ui.data.translation_settings.target_languages), '["en"]')
  check('locale 回读', ui.data.locale, 'zh-CN')
  const ps2 = await api('POST', '/user/personal_stats', { token, body: {} })
  check('personal_stats 跟随开关', ps2.data.enabled, true)

  const ic = await api('GET', '/user/get_invitation_codes', { token })
  check('邀请码空列表', Array.isArray(ic.data.invitation_codes), true)

  const gc = await api('POST', '/gift_card/my_cards', { token, body: { page: 1, page_size: 20 } })
  check('礼品卡空列表', Array.isArray(gc.data.cards), true)
  check('礼品卡分页回显', gc.data.current_page, 1)

  const org = await api('POST', '/organization/get_info', { token, body: { org_id: 'none' } })
  check('组织信息为空', org.data, null)

  const fb = new FormData()
  fb.append('data', JSON.stringify({ rating: 5, feedback: '好用' }))
  const fbr = await fetch(`${BASE}/user/feedback`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fb
  }).then((x) => x.json())
  check('反馈(multipart)成功', fbr.status, 'OK')

  const dg = await api('POST', '/user/diagnostics_report', { token, body: { diagnostic_info: {} } })
  check('诊断上报成功', dg.status, 'OK')
}

console.log('\n=== 账号删除（A4）===')
{
  const delEmail = `del-${Date.now()}@opentype.dev`
  const reg = await api('POST', '/oauth/register', { body: { email: delEmail, password: 'del-password-1' } })
  const delToken = reg.data.access_token
  const delRefresh = reg.data.refresh_token

  await api('POST', '/user/dictionary/add', { token: delToken, body: { term: '再见' } })
  await api('POST', '/transcription_history/push', {
    token: delToken,
    body: { records: [{ id: 'del-r1', status: 'completed', mode: 'voice_transcript', refined_text: '删号记录' }] }
  })

  const del = await api('POST', '/user/delete_account', { token: delToken, body: { reason: '测试' } })
  check('删除账号成功', del.status, 'OK')

  const info = await api('GET', '/user/get_user_info', { token: delToken })
  check('删除后用户信息 401', info.status, 'ERROR')

  const relogin = await api('POST', '/oauth/login', { body: { email: delEmail, password: 'del-password-1' } })
  check('删除后无法登录', relogin.detail, 'invalid_credentials')

  const refr = await api('POST', '/oauth/refresh_access_token', { body: { refresh_token: delRefresh } })
  check('删除后 refresh 失效', refr.detail, 'invalid_refresh_token')

  // 同邮箱可重新注册（账号数据已清）
  const re = await api('POST', '/oauth/register', { body: { email: delEmail, password: 'del-password-2' } })
  check('删除后可重新注册', re.status, 'OK')
  const words = await api('GET', '/user/dictionary/list', { token: re.data.access_token })
  check('新账号词典为空', words.data.total_count, 0)
}

console.log('\n=== 同步关闭保护 ===')
{
  const reg = await api('POST', '/oauth/register', { body: { email: `sync-off-${Date.now()}@example.test`, password: 'synthetic-sync-password' } })
  const syncToken = reg.data.access_token
  const off = await api('POST', '/transcription_history/sync_settings', { token: syncToken, body: { sync_enabled: false } })
  check('关闭状态已保存', off.data.sync_enabled, false)
  const body = { records: [{ id: 'off-test', status: 'completed', mode: 'voice_transcript', refined_text: 'Synthetic private text' }] }
  const rejected = await api('POST', '/transcription_history/push', { token: syncToken, body })
  check('关闭后服务端拒绝上传', rejected.detail, 'sync_disabled')
  check('关闭后返回 403', rejected.code, 403)
  const empty = await api('POST', '/transcription_history/sync_status', { token: syncToken, body: {} })
  check('关闭后云端没有新增数据', empty.data.total, 0)
  await api('POST', '/transcription_history/sync_settings', { token: syncToken, body: { sync_enabled: true } })
  const accepted = await api('POST', '/transcription_history/push', { token: syncToken, body })
  check('重新开启后可同步', accepted.data.accepted, ['off-test'])
}

console.log('\n=== 增量分页不丢同批记录 ===')
{
  const reg = await api('POST', '/oauth/register', { body: { email: `paging-${Date.now()}@example.test`, password: 'synthetic-paging-password' } })
  const pagingToken = reg.data.access_token
  const records = Array.from({ length: 137 }, (_, i) => ({ id: `page-${i}`, status: 'completed', mode: 'voice_transcript', refined_text: `Synthetic ${i}` }))
  await api('POST', '/transcription_history/push', { token: pagingToken, body: { records } })
  for (const backwards of [false, true]) {
    let cursor = backwards ? null : 0
    const ids = []
    for (let round = 0; round < 30; round++) {
      const r = await api('POST', backwards ? '/transcription_history/load_older' : '/transcription_history/pull', {
        token: pagingToken, body: backwards ? { before: cursor, limit: 7 } : { since: cursor, limit: 7 }
      })
      ids.push(...r.data.records.map(x => x.id))
      cursor = r.data.cursor
      if (!r.data.has_more) break
    }
    check(`${backwards ? '倒序' : '增量'}分页无丢失`, ids.length, 137)
    check(`${backwards ? '倒序' : '增量'}分页无重复`, new Set(ids).size, 137)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const legacyDb = new DatabaseSync(DB)
  legacyDb.prepare('UPDATE history SET server_updated_at = ? WHERE user_id = ?').run(Date.now() - 1000, reg.data.user_id)
  legacyDb.close()
  const legacy = await api('POST', '/transcription_history/pull', { token: pagingToken, body: { since: 0, limit: 7 } })
  check('旧版相同时间戳记录不被切断', legacy.data.records.length, 137)
  check('旧版相同时间戳已完整拉取', legacy.data.has_more, false)
}

cleanup()
console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
