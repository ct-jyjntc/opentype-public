// No mail is delivered: positive HTTPS cases use a fake fetch; real requests stay on loopback.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { sendMail } from '../src/services/mail.ts'
let passed = 0
const originalFetch = globalThis.fetch
const originalLog = console.log, originalError = console.error
const logs = []
console.log = (...args) => logs.push(args.join(' ')); console.error = (...args) => logs.push(args.join(' '))
const message = { to: 'synthetic-recipient@invalid', subject: 'synthetic-subject', text: 'synthetic-code-123456' }
const params = { mode: 'voice_transcript', audio: Buffer.from('synthetic-audio'), filename: 'test.wav' }
const ok = name => { passed++; originalLog('OK ' + name) }
try {
  process.env.ASR_URL = 'http://unsafe.example'
  process.env.LLM_URL = 'http://unsafe.example'
  process.env.MAIL_API_URL = 'http://unsafe.example/mail'
  process.env.MAIL_FROM = 'synthetic-sender@invalid'
  process.env.MAIL_API_KEY = 'synthetic-mail-key'; process.env.LLM_API_KEY = 'synthetic-llm-key'
  process.env.ENABLE_REFINE = 'true'
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not request') }
  const unsafe = await import('../src/services/voice.ts?unsafe-network-test')
  await assert.rejects(unsafe.voiceFlow(params), /insecure_cloud_url/)
  assert.equal((await unsafe.refineText('synthetic-text', 'voice_transcript')).refine_failed, true)
  assert.equal(await sendMail(message), false)
  assert.equal(calls, 0)
  ok('server audio, LLM and mail reject plaintext before calling fetch')

  process.env.ASR_URL = 'https://asr.example'
  process.env.LLM_URL = 'https://llm.example'
  process.env.MAIL_API_URL = 'https://mail.example/send'
  const seen = []
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), options })
    assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify(String(url).endsWith('/inference') ? { text: 'synthetic-transcript' } : { choices: [{ message: { content: 'synthetic-refined' } }] }), { status: 200 })
  }
  const secure = await import('../src/services/voice.ts?secure-network-test')
  assert.equal((await secure.voiceFlow(params)).refine_text, 'synthetic-refined')
  assert.equal(await sendMail(message), true)
  assert.equal(seen.length, 3)
  assert.equal(seen[0].options.headers, undefined)
  assert.equal(seen[1].options.headers.authorization, 'Bearer synthetic-llm-key')
  assert.equal(seen[2].options.headers.authorization, 'Bearer synthetic-mail-key')
  ok('HTTPS server forwarding keeps ASR, LLM and mail credentials separate and disables redirects')

  globalThis.fetch = originalFetch
  let traps = 0
  const trap = createServer((_req, res) => { traps++; res.end('{}') })
  await new Promise(r => trap.listen(0, '127.0.0.1', r))
  const redirect = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${trap.address().port}/trap` }); res.end() })
  await new Promise(r => redirect.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${redirect.address().port}`
    process.env.ASR_URL = base; process.env.LLM_URL = base; process.env.MAIL_API_URL = base
    const redirected = await import('../src/services/voice.ts?redirect-network-test')
    await assert.rejects(redirected.voiceFlow(params))
    assert.equal((await redirected.refineText('synthetic', 'voice_transcript')).refine_failed, true)
    assert.equal(await sendMail(message), false)
    assert.equal(traps, 0)
    ok('real HTTP 307 cannot forward server audio, LLM text or mail to a second endpoint')
  } finally {
    for (const server of [redirect, trap]) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  }
  process.env.MAIL_API_URL = ''; process.env.MAIL_FROM = ''
  assert.equal(await sendMail(message), false)
  for (const secret of [message.to, message.text, 'synthetic-mail-key', 'synthetic-llm-key']) assert(!logs.join('\n').includes(secret))
  ok('mail failure and missing configuration logs contain no recipient, code or API key')
} finally { globalThis.fetch = originalFetch; console.log = originalLog; console.error = originalError }
console.log(`${passed} server network scenarios passed`)
