import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { initDatabase, closeDatabase, HistoryRepo } from '../src/main/db'
import { fromFrontendHistory } from '../src/main/services/frontend-shape'
import { RendererVoiceService } from '../src/main/services/renderer-voice'
import { OpenAIProvider } from '../src/main/services/providers/openai'
import { CustomProvider } from '../src/main/services/providers/custom'
import { FallbackProvider } from '../src/main/services/providers'
import type { SpeechProvider, TranscribeParams, TranscribeResult } from '../src/main/services/providers/types'

let passed = 0
async function test(name: string, fn: () => Promise<void>) {
  await fn(); passed++; console.log(`OK ${name}`)
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { assert(Date.now() < deadline, 'condition timeout'); await delay(5) }
}

const dir = mkdtempSync(join(tmpdir(), 'opentype-renderer-voice-test-'))
initDatabase(dir)
const config = { asrLanguage: 'auto', outputLanguage: 'en', blacklistDomains: [] as string[] }
let received: TranscribeParams | undefined
let provider: SpeechProvider = { name: 'capture', transcribe: async p => {
  received = p; return { success: true, text: 'result', rawText: 'raw' }
} }
const service = new RendererVoiceService({ getProvider: () => provider, loadHistory: id => HistoryRepo.byId(id), getConfig: () => config })
const request = (audioId: string, abortId = audioId) => ({ audioId, abortId, arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer })
const writeRecord = async (id: string, patch: Record<string, unknown> = {}) => {
  await HistoryRepo.upsert(fromFrontendHistory({ id, mode: 'voice_command', duration: 2,
    mode_meta: { selected_text: 'Synthetic selected text' },
    audio_metadata: { sample_rate: 16000, channel_count: 1 },
    audio_context: { active_application: { app_name: 'Editor', app_identifier: 'example.editor' },
      text_insertion_point: { cursor_state: { surrounding_text: 'Synthetic surrounding text' } } }, ...patch
  }) as any)
}

try {
  await test('real SQLite camelCase/blob row preserves selection, context and audio metadata', async () => {
    await writeRecord('metadata')
    const result = await service.run(request('metadata'))
    assert.equal(result.success, true)
    assert.equal(received?.parameters?.selected_text, 'Synthetic selected text')
    assert.equal(received?.audioContext.app_name, 'Editor')
    assert.equal(received?.audioContext.input_context, 'Synthetic surrounding text')
    assert.equal(received?.audioMetadata.sample_rate, 16000)
    assert.equal(received?.audioMetadata.audio_duration, 2)
    assert.equal(result.raw_text, 'raw')
  })

  await test('translation retry restores target language from persisted mode metadata', async () => {
    await writeRecord('translation', { mode: 'voice_translation', mode_meta: { output_language: 'ja' } })
    await service.run({ ...request('translation'), isRetry: true })
    assert.equal(received?.parameters?.output_language, 'ja')
    assert.equal(received?.parameters?.language, 'auto')
    await service.run({ ...request('translation'), outputLanguage: 'de' })
    assert.equal(received?.parameters?.output_language, 'de')
  })

  await test('sensitive application context and selected text never reach provider', async () => {
    await writeRecord('private', { audio_context: { app_name: 'Terminal', bundle_id: 'com.apple.Terminal', input_context: 'SYNTHETIC SECRET', web_url: 'https://secret.test/' } })
    await service.run(request('private'))
    assert.equal(received?.audioContext.redacted, true)
    assert.equal(received?.audioContext.input_context, '')
    assert.equal(received?.audioContext.web_url, '')
    assert.equal(received?.parameters?.selected_text, undefined)
    assert(!JSON.stringify(received).includes('SYNTHETIC SECRET'))
  })

  await test('domain blacklist respects subdomain boundaries', async () => {
    config.blacklistDomains = ['secret.test']
    await writeRecord('domain', { audio_context: { web_url: 'https://sub.secret.test/doc', input_context: 'protected' } })
    await service.run(request('domain'))
    assert.equal(received?.audioContext.redacted, true)
    await writeRecord('not-domain', { audio_context: { web_url: 'https://notsecret.test/doc', input_context: 'allowed' } })
    await service.run(request('not-domain'))
    assert.equal(received?.audioContext.input_context, 'allowed')
    config.blacklistDomains = []
  })

  await test('cancellation during database read prevents any provider request', async () => {
    let release!: (row: null) => void
    let calls = 0
    const slow = new RendererVoiceService({
      getProvider: () => ({ name: 'must-not-run', transcribe: async () => { calls++; return { success: true } } }),
      loadHistory: () => new Promise(resolve => { release = resolve }), getConfig: () => config
    })
    const pending = slow.run(request('cancel-before-upload', 'cancel-id'))
    slow.cancel('cancel-id')
    release(null)
    const result = await pending
    assert.equal(result.aborted, true)
    assert.equal(result.success, false)
    assert.equal(calls, 0)
    slow.dispose()
  })

  await test('request cancellation is isolated and stale provider results are ignored', async () => {
    const pending = new Map<string, { resolve: (r: TranscribeResult) => void; signal: AbortSignal }>()
    provider = { name: 'slow', transcribe: p => new Promise(resolve => pending.set(p.audioId, { resolve, signal: p.signal! })) }
    const a = service.run(request('cancel-a', 'a'))
    const b = service.run(request('keep-b', 'b'))
    await until(() => pending.size === 2)
    service.cancel('a')
    assert.equal(pending.get('cancel-a')?.signal.aborted, true)
    assert.equal(pending.get('keep-b')?.signal.aborted, false)
    pending.get('cancel-a')!.resolve({ success: true, text: 'late output' })
    pending.get('keep-b')!.resolve({ success: true, text: 'valid output' })
    const cancelled = await a
    assert.equal(cancelled.success, false)
    assert.equal(cancelled.refine_text, '')
    assert.equal(cancelled.aborted, true)
    assert.equal((await b).refine_text, 'valid output')
  })

  await test('invalid audio never enters network provider', async () => {
    let calls = 0
    provider = { name: 'invalid', transcribe: async () => { calls++; return { success: true } } }
    const result = await service.run({ audioId: 'empty', arrayBuffer: new ArrayBuffer(0) })
    assert.equal(result.detail, 'empty_audio')
    assert.equal(result.success, false)
    assert.equal(calls, 0)
  })

  let failRefine = true, holdRefine = false, refining = false, disconnected = false
  let asrLanguage: FormDataEntryValue | null = null
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.url === '/v1/audio/transcriptions') {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData()
      asrLanguage = form.get('language')
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: '明天下午开会。' }))
    } else if (req.url === '/v1/chat/completions') {
      refining = true
      if (holdRefine) { res.once('close', () => { disconnected = true }); return }
      res.writeHead(failRefine ? 503 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(failRefine ? { error: 'unavailable' } : { choices: [{ message: { content: 'Meet tomorrow afternoon.' } }] }))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'OK', data: { refine_text: 'untranslated', raw_text: 'raw', refine_failed: true } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const params: TranscribeParams = { mode: 'voice_translation', audio: new Uint8Array([1,2,3,4]), audioId: 'network', duration: 1,
    audioMetadata: {}, audioContext: {}, parameters: { language: 'auto', output_language: 'en' } }
  try {
    const openai = new OpenAIProvider({ kind: 'openai', baseUrl, appVersion: 'test' })
    await test('failed translation/command returns failure with raw transcript; dictation marks fallback', async () => {
      for (const mode of ['voice_translation', 'voice_command'] as const) {
        const result = await openai.transcribe({ ...params, mode })
        assert.equal(result.success, false)
        assert.equal(result.rawText, '明天下午开会。')
        assert.equal(result.text, undefined)
      }
      const dictation = await openai.transcribe({ ...params, mode: 'voice_transcript' })
      assert.equal(dictation.success, true)
      assert.equal(dictation.detail, 'refine_failed')
      assert.equal(asrLanguage, null, 'auto and translation target must not be sent as ASR language')
    })

    await test('dictation polish preference does not disable translation', async () => {
      failRefine = false
      const noPolish = new OpenAIProvider({ kind: 'openai', baseUrl, appVersion: 'test', refine: false })
      assert.equal((await noPolish.transcribe(params)).text, 'Meet tomorrow afternoon.')
    })

    await test('cancellation aborts the actual HTTP refinement request', async () => {
      holdRefine = true; refining = false
      const controller = new AbortController()
      const pending = openai.transcribe({ ...params, signal: controller.signal })
      await until(() => refining)
      controller.abort()
      const result = await pending
      assert.equal(result.success, false)
      assert.equal(result.detail, 'cancelled')
      await until(() => disconnected)
    })

    await test('custom protocol cannot turn failed translation into success', async () => {
      const custom = new CustomProvider({ kind: 'custom', baseUrl, appVersion: 'test' })
      assert.equal((await custom.transcribe(params)).success, false)
      assert.equal((await custom.transcribe({ ...params, mode: 'voice_transcript' })).detail, 'refine_failed')
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  await test('cancellation and invalid requests never launch a fallback provider', async () => {
    let fallbackCalls = 0
    const fallback: SpeechProvider = { name: 'fallback', transcribe: async () => { fallbackCalls++; return { success: true, text: 'wrong' } } }
    for (const result of [{ success: false, detail: 'cancelled' }, { success: false, code: 400, detail: 'invalid_request' }]) {
      const combined = new FallbackProvider({ name: 'primary', transcribe: async () => result }, fallback)
      assert.equal((await combined.transcribe(params)).success, false)
    }
    assert.equal(fallbackCalls, 0)
  })
} finally {
  service.dispose(); closeDatabase(); rmSync(dir, { recursive: true, force: true })
}
console.log(`${passed} voice integration scenarios passed`)
