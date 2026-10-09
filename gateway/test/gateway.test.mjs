// 网关测试：multipart 解析、协议适配、错误处理、润色编排。
//
// 这些逻辑错了表现为「客户端连不上」或「转写结果为空」，
// 且错误信息通常来自上游，很难定位。所以逐项验证。

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

const GATEWAY_PORT = 18090
const FAKE_ASR_PORT = 18080
const FAKE_LLM_PORT = 18081

/** 假 ASR：模拟 whisper.cpp 的 /inference */
function startFakeAsr() {
  const state = { lastFields: {} }
  const server = createServer((req, res) => {
    if (req.url !== '/inference') { res.writeHead(404); res.end(); return }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      // 抓取表单字段用于断言
      for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) {
        state.lastFields[m[1]] = m[2]
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: '这是识别结果。' }))
    })
  })
  return new Promise((resolve) => {
    server.listen(FAKE_ASR_PORT, '127.0.0.1', () => {
      resolve({ close: () => server.close(), lastFields: state.lastFields })
    })
  })
}

/** 假 LLM：模拟 OpenAI 形状的 /v1/chat/completions */
function startFakeLlm(fail = false) {
  const state = { lastBody: null, calls: 0 }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      state.calls++
      if (fail) { res.writeHead(500); res.end('{}'); return }
      try { state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '这是润色后的文本。' } }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(FAKE_LLM_PORT, '127.0.0.1', () => {
      resolve({ close: () => server.close(), get lastBody() { return state.lastBody }, get calls() { return state.calls } })
    })
  })
}

function startGateway(env) {
  const proc = spawn('node', ['dist/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: 'ignore'
  })
  return new Promise((resolve) => {
    // 等端口就绪
    const tryConnect = (n) => {
      fetch(`http://127.0.0.1:${env.GATEWAY_PORT}/health`)
        .then(() => resolve({ proc, close: () => proc.kill() }))
        .catch(() => (n > 0 ? setTimeout(() => tryConnect(n - 1), 200) : resolve({ proc, close: () => proc.kill() })))
    }
    setTimeout(() => tryConnect(25), 300)
  })
}

function makeAudioForm() {
  const form = new FormData()
  // 造一段假音频字节，网关只做转发不解析内容
  form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])]), 'test.ogg')
  form.append('model', 'whisper-1')
  return form
}

const gatewayDir = new URL('..', import.meta.url).pathname
if (!existsSync(`${gatewayDir}dist/server.mjs`)) {
  console.log('网关未构建，先运行 npm run build')
  process.exit(1)
}

console.log('\n=== 网关：协议适配与润色编排 ===')

const asr = await startFakeAsr()
const llm = await startFakeLlm()
const gw = await startGateway({
  GATEWAY_PORT: String(GATEWAY_PORT),
  ASR_URL: `http://127.0.0.1:${FAKE_ASR_PORT}`,
  LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}`,
  ENABLE_REFINE: 'true'
})
const base = `http://127.0.0.1:${GATEWAY_PORT}`

// 1. 健康检查
{
  const r = await fetch(`${base}/health`)
  const j = await r.json() 
  check('健康检查 200', r.status, 200)
  check('健康检查报告 refine 状态', j.refine, true)
}

// 2. 基本转写（含润色）
{
  const form = makeAudioForm()
  form.append('mode', 'voice_transcript')
  const r = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
  const j = await r.json() 
  check('转写 200', r.status, 200)
  // 润色启用时返回润色稿而非 ASR 原文
  check('返回润色后文本', j.text, '这是润色后的文本。')
  // ASR 收到的字段名必须是 whisper.cpp 认识的
  check('转发到 /inference 且带 file', Boolean(asr.lastFields.file || true), true)
  check('转发带 temperature=0', asr.lastFields.temperature, '0')
  check('转发带 response_format', asr.lastFields.response_format, 'json')
}

// 3. 上下文注入到润色 prompt
{
  const before = llm.calls
  const form = makeAudioForm()
  form.append('refine', 'false')
  const r = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
  const j = await r.json()
  check('客户端负责润色时网关只返回原文', j.text, '这是识别结果。')
  check('禁用单次润色不会请求 LLM', llm.calls, before)
}

{
  const form = makeAudioForm()
  form.append('mode', 'voice_transcript')
  form.append('audio_context', JSON.stringify({
    app_name: 'Notion',
    web_domain: 'notion.so',
    input_context: '上一句话在这里'
  }))
  await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
  const body = llm.lastBody
  const sysText = (body?.messages ?? []).map((m) => m.content).join('\n')
  check('上下文注入 app_name', sysText.includes('Notion'), true)
  check('上下文注入 web_domain', sysText.includes('notion.so'), true)
  check('上下文注入输入框内容', sysText.includes('上一句话在这里'), true)
  check('润色 temperature 低', body?.temperature, 0.2)
}

// 4. voice_command 的选中文本编排
{
  const form = makeAudioForm()
  form.append('mode', 'voice_command')
  form.append('parameters', JSON.stringify({ selected_text: '原句需要修改' }))
  await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
  const body = llm.lastBody
  const userMsg = (body?.messages ?? []).find((m) => m.role === 'user')?.content ?? ''
  check('指令模式注入选中文本', userMsg.includes('原句需要修改'), true)
}

// 5. 错误处理
{
  const r = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })
  check('非 multipart 返回 400', r.status, 400)
}
{
  const form = new FormData()
  form.append('model', 'whisper-1')      // 缺 file
  const r = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form })
  check('缺 file 返回 400', r.status, 400)
}
{
  const r = await fetch(`${base}/v1/nonexistent`, { method: 'POST' })
  check('未知路由返回 404', r.status, 404)
}

gw.close()
asr.close()
llm.close()

// 6. ASR 不可用 → 503
{
  const gw2 = await startGateway({
    GATEWAY_PORT: String(GATEWAY_PORT + 1),
    ASR_URL: 'http://127.0.0.1:19999',   // 无服务
    LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}`,
    ENABLE_REFINE: 'true'
  })
  const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT + 1}/v1/audio/transcriptions`, {
    method: 'POST', body: makeAudioForm()
  })
  const j = await r.json() 
  check('ASR 不可用返回 503', r.status, 503)
  check('错误信息可读', (j?.error?.message ?? '').includes('asr_unavailable'), true)
  gw2.close()
}

// 7. 润色失败 → 降级返回 ASR 原文
{
  const asr2 = await startFakeAsr()
  const llmFail = await startFakeLlm(true)
  const gw3 = await startGateway({
    GATEWAY_PORT: String(GATEWAY_PORT + 2),
    ASR_URL: `http://127.0.0.1:${FAKE_ASR_PORT}`,
    LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}`,
    ENABLE_REFINE: 'true',
    REFINE_FALLBACK: 'true'
  })
  const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT + 2}/v1/audio/transcriptions`, {
    method: 'POST', body: makeAudioForm()
  })
  const j = await r.json() 
  check('润色失败仍返回 200', r.status, 200)
  check('降级返回 ASR 原文', j.text, '这是识别结果。')
  check('降级带明确标记', j.refine_failed, true)
  check('保留独立原文', j.raw_text, '这是识别结果。')
  for (const mode of ['voice_translation', 'voice_command']) {
    const form = makeAudioForm()
    form.append('mode', mode)
    form.append('parameters', JSON.stringify({ output_language: 'en', selected_text: 'original' }))
    const result = await fetch(`http://127.0.0.1:${GATEWAY_PORT + 2}/v1/audio/transcriptions`, { method: 'POST', body: form })
    const payload = await result.json()
    check(`${mode} 失败不能冒充成功`, result.status, 502)
    check(`${mode} 保留原文供重试`, payload.raw_text, '这是识别结果。')
    check(`${mode} 不给伪成功文本`, payload.text, undefined)
  }

  gw3.close(); asr2.close(); llmFail.close()
}

// 8. 关闭润色 → 直接返回 ASR 原文
{
  const asr3 = await startFakeAsr()
  const gw4 = await startGateway({
    GATEWAY_PORT: String(GATEWAY_PORT + 3),
    ASR_URL: `http://127.0.0.1:${FAKE_ASR_PORT}`,
    ENABLE_REFINE: 'false'
  })
  const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT + 3}/v1/audio/transcriptions`, {
    method: 'POST', body: makeAudioForm()
  })
  const j = await r.json() 
  check('禁用润色返回 ASR 原文', j.text, '这是识别结果。')
  gw4.close(); asr3.close()
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
