import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { createServer } from 'node:http'
import { refineTranscript } from '../src/main/services/providers/refinement'
import { LocalProvider } from '../src/main/services/providers'
import { applyPendingRefinement } from '../src/main/services/refinement-setup'
import { SecureConfigStore } from '../src/main/services/secure-store'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TranscribeParams } from '../src/main/services/providers/types'

const original = getGlobalDispatcher(), mock = new MockAgent()
mock.disableNetConnect(); mock.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(mock)
const pool = mock.get('https://api.deepseek.com')
const config = { provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-refine-key', enabled: true }
const params: TranscribeParams = { mode: 'voice_transcript', audio: new TextEncoder().encode('SYNTHETIC_AUDIO_NEVER_SEND'), audioId: 'test', duration: 1, audioMetadata: {}, audioContext: {} }
const success = (text = '整理后的文本') => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] })
let count = 0
async function test(name: string, run: () => Promise<void>) { await run(); console.log(`OK ${name}`); count++ }
try {
  await test('official endpoint, separate credential, thinking disabled, text-only request', async () => {
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
      const body = JSON.parse(String(options.body))
      assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.equal(body.stream, false)
      assert(!String(options.body).includes('SYNTHETIC_AUDIO'))
      assert(!String(options.body).includes('SYNTHETIC_PRIVATE_CONTEXT'))
      assert.equal(JSON.parse(body.messages[1].content).transcript, '原文')
      assert(JSON.stringify(options.headers).includes('synthetic-refine-key'))
      return { statusCode: 200, data: success() }
    })
    assert.deepEqual(await refineTranscript('原文', { ...params, audioContext: { redacted: true, input_context: 'SYNTHETIC_PRIVATE_CONTEXT' } }, config), { success: true, text: '整理后的文本', rawText: '原文' })
  })
  await test('translation target and selected text reach their intended modes', async () => {
    for (const mode of ['voice_translation', 'voice_command'] as const) {
      pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
        const data = JSON.parse(JSON.parse(String(options.body)).messages[1].content)
        if (mode === 'voice_translation') assert.equal(data.target_language, 'ja')
        else assert.equal(data.selected_text, '待编辑的文本')
        return { statusCode: 200, data: success() }
      })
      assert.equal((await refineTranscript('指令', { ...params, mode, parameters: { output_language: 'ja', selected_text: '待编辑的文本' } }, config)).success, true)
    }
  })
  await test('redacted command selection never crosses the refinement request boundary', async () => {
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
      assert(!String(options.body).includes('PRIVATE_SELECTED_CONTENT'))
      const data=JSON.parse(JSON.parse(String(options.body)).messages[1].content)
      assert.equal(data.selected_text,'');assert.equal(data.context,undefined)
      return {statusCode:200,data:success()}
    })
    assert.equal((await refineTranscript('解释一下', {...params,mode:'voice_command',audioContext:{redacted:true},parameters:{selected_text:'PRIVATE_SELECTED_CONTENT'}},config)).success,true)
  })
  await test('length cutoff, missing finish reason, reasoning and empty text preserve raw text as failure', async () => {
    const bad = [
      { choices: [{ finish_reason: 'length', message: { content: 'truncated' } }] },
      { choices: [{ message: { content: 'unknown completion' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: 'answer', reasoning_content: 'unexpected thought' } }] },
      success('   ')
    ]
    for (const response of bad) {
      pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(200, response)
      assert.deepEqual(await refineTranscript('原文', { ...params, mode: 'voice_translation', parameters: { output_language: 'en' } }, config), { success: false, rawText: '原文', detail: 'refine_failed' })
    }
  })
  await test('unavailable refinement allows raw dictation, never pretends to translate', async () => {
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(503, {})
    assert.deepEqual(await refineTranscript('原文', params, config), { success: true, text: '原文', rawText: '原文', detail: 'refine_failed' })
    assert.equal((await refineTranscript('原文', { ...params, mode: 'voice_command' }, { ...config, enabled: false })).success, false)
    assert.deepEqual(await refineTranscript('原文', params, { ...config, enabled: false }), { success: true, text: '原文', rawText: '原文' })
    assert.equal((await refineTranscript('原文', params, { ...config, apiKey: '' })).detail, 'refine_unavailable')
  })
  await test('untrusted endpoint and HTTP redirect never receive key', async () => {
    for (const baseUrl of ['http://api.deepseek.com', 'https://example.com', 'https://api.deepseek.com.evil.example', 'https://api.deepseek.com@evil.example']) {
      assert.equal((await refineTranscript('原文', params, { ...config, baseUrl })).detail, 'invalid_refine_endpoint')
    }
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(302, '', { headers: { location: 'https://example.com/key-target' } })
    assert.equal((await refineTranscript('原文', params, config)).detail, 'refine_failed')
  })
  await test('pre-aborted and in-flight cancellation prevent insertion', async () => {
    assert.equal((await refineTranscript('原文', { ...params, signal: AbortSignal.abort() }, config)).detail, 'cancelled')
    const abort = new AbortController()
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(200, success()).delay(200)
    const pending = refineTranscript('原文', { ...params, signal: abort.signal }, config)
    setTimeout(() => abort.abort(), 10)
    assert.equal((await pending).detail, 'cancelled')
  })
  await test('LocalProvider suppresses gateway refinement; only main calls DeepSeek', async () => {
    const remote = new LocalProvider({ kind: 'local', baseUrl: 'https://example.com', appVersion: 'test', refinement: config })
    assert.deepEqual(await remote.transcribe(params), { success: false, detail: 'invalid_local_endpoint', code: 400 })
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      assert(!req.headers.authorization)
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData()
      assert.equal(form.get('refine'), 'false'); assert.equal(form.get('mode'), 'voice_transcript')
      assert.equal(form.get('audio_context'), null); assert.equal(form.get('parameters'), null)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: '原文', raw_text: '原文' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(200, success('translated'))
      const provider = new LocalProvider({ kind: 'local', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, appVersion: 'test', refinement: config })
      assert.deepEqual(await provider.transcribe({ ...params, mode: 'voice_translation', parameters: { output_language: 'en' } }), { success: true, text: 'translated', rawText: '原文' })
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  await test('encrypted pending setup imports once and keeps unrelated settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opentype-pending-refine-')), path = join(dir, 'setup.json')
    const encryption = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() }
    const backend = { store: { provider: 'local', apiKey: 'synthetic-asr' } as Record<string, unknown>, set(values: Record<string, unknown>) { Object.assign(this.store, values) } }
    try {
      const store = new SecureConfigStore(backend, encryption)
      writeFileSync(path, JSON.stringify({ version: 1, ciphertext: encryption.encryptString(JSON.stringify({ refineBaseUrl: config.baseUrl, refineModel: config.model, refineApiKey: config.apiKey })).toString('base64') }))
      const unavailableStore = new SecureConfigStore({ store: {}, set() {} }, { ...encryption, encryptString() { throw new Error('locked') } })
      await assert.rejects(applyPendingRefinement(path, encryption, unavailableStore), /not_persisted/)
      assert.equal(existsSync(path), true, 'Keep the encrypted pending setup if persistence fails')
      assert.equal(await applyPendingRefinement(path, encryption, store), true)
      assert.equal(store.get('apiKey'), 'synthetic-asr'); assert.equal(store.get('refineApiKey'), config.apiKey)
      assert.equal(store.get('provider'), 'local'); assert.equal(existsSync(path), false)
      assert.equal(await applyPendingRefinement(path, encryption, store), false)
      writeFileSync(path, '{"version":0}')
      await assert.rejects(applyPendingRefinement(path, encryption, store))
      assert.equal(readFileSync(path, 'utf8'), '{"version":0}')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await test('dictation receives only the resolved expression and bounded style, not application rules', async () => {
    pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
      const body = JSON.parse(String(options.body)), data = JSON.parse(body.messages[1].content)
      assert.match(data.expression, /正式/)
      assert.equal(data.style, '简洁')
      assert.deepEqual(data.dictionary, [{ term: 'OpenType' }])
      assert.equal(data.appExpressions, undefined)
      assert.match(body.messages[0].content, /不得改变事实、数字、名称、代码、链接或完整信息/)
      return { statusCode: 200, data: success('测试稿') }
    })
    const result = await refineTranscript('原文', { ...params, parameters: { style: '简洁', dictionary: [{ term: 'OpenType' }],
      output_preferences: { punctuation: 'chinese', spacing: 'space', expression: 'formal' }, appExpressions: ['do not send'] } }, config)
    assert.equal(result.text, '测试稿'); assert.equal(result.rawText, '原文')
  })
  await test('translation and command receive no dictation style or application expression instructions', async () => {
    for (const mode of ['voice_translation', 'voice_command'] as const) {
      pool.intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
        const body = JSON.parse(String(options.body)), data = JSON.parse(body.messages[1].content)
        assert.equal(data.expression, undefined); assert.equal(data.style, undefined)
        assert(!body.messages[0].content.includes('expression'))
        return { statusCode: 200, data: success('result') }
      })
      assert.equal((await refineTranscript('原文', { ...params, mode, parameters: { output_language: 'en', style: 'casual',
        output_preferences: { punctuation: 'chinese', spacing: 'space', expression: 'formal' } } }, config)).text, 'result')
    }
  })
  mock.assertNoPendingInterceptors()
  console.log(`${count} refinement scenarios passed`)
} finally { setGlobalDispatcher(original); await mock.close() }
