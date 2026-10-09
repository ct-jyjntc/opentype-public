import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

// Exercise the actual generated module imported by the shipped UI, not a lookalike fixture.
const code = await readFile(new URL('../frontend/renderer/static/js/opentype-voice-transport.js', import.meta.url), 'utf8')
const { IpcVoiceTransport } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(override = {}, timeoutMs) {
  const calls = [], states = [], results = [], errors = [], broadcasts = [], paywalls = []
  const outcome = deferred()
  let acks = 0, destroyed = false
  const transport = new IpcVoiceTransport({
    onStateUpdate: s => states.push(s),
    onRefineCompleted: r => { results.push(r); outcome.resolve('success') },
    onError: e => { errors.push(e); outcome.resolve('error') },
    onSessionInterrupt: p => { paywalls.push(p); outcome.resolve('paywall') },
    onReceivedChunkConfirm: () => { acks++ }
  }, {
    timeoutMs,
    invoke: async (channel, payload) => {
      calls.push({ channel, payload })
      if (override[channel]) return override[channel](payload)
      if (channel === 'audio:opus-compress-by-audio-id') return { outputArrayBuffer: new Uint8Array([1, 2]) }
      if (channel === 'audio:ai-voice-flow') return { success: true, refine_text: '结果', raw_text: '原文' }
      return { success: true }
    },
    eventManager: {
      broadcastMessageLifecycle: (...args) => broadcasts.push(args),
      destroy: () => { destroyed = true }
    }
  })
  return { transport, calls, states, results, errors, broadcasts, paywalls, outcome,
    get acks() { return acks }, get destroyed() { return destroyed } }
}

test('recording end immediately uses IPC, preserves translation target and completion broadcast', async () => {
  const f = fixture()
  await f.transport.connect()
  assert.equal(f.transport.getReadyState(), 1)
  f.transport.sendMessage('audio', { type: 'start_audio' })
  f.transport.sendAudioChunk('audio', new Blob(['data']))
  assert.equal(f.acks, 1)
  const started = performance.now()
  f.transport.sendMessage('audio', { type: 'end_audio', mode_meta: { output_language: 'fr' }, client_metadata: { taking_longer_alert_delay_ms: 6000 } })
  assert.equal(await f.outcome.promise, 'success')
  assert.ok(performance.now() - started < 1000, 'must not wait for the old six-second fallback')
  assert.equal(f.calls.find(c => c.channel === 'audio:ai-voice-flow').payload.outputLanguage, 'fr')
  assert.equal(f.states.at(-1).isRefining, false)
  assert.equal(f.broadcasts.filter(b => b[0] === 'audio_processing_completed').length, 1)
  assert.equal(f.calls.find(c => c.channel === 'db:history-upsert-mode-meta').payload.modeMetaPatch.raw_text, '原文')
  assert.ok(!f.calls.some(c => c.channel.includes('clean-opus') || c.channel.includes('auth:')))
  f.transport.sendMessage('audio', { type: 'end_audio' })
  await tick()
  assert.equal(f.results.length, 1, 'duplicate end must not insert twice')
  f.transport.cleanup()
})

test('provider failure ends the spinner and broadcasts an error, preserving original text', async () => {
  const f = fixture({ 'audio:ai-voice-flow': () => ({ success: false, detail: 'refine_failed', raw_text: '原文' }) })
  f.transport.sendMessage('audio', { type: 'end_audio' })
  assert.equal(await f.outcome.promise, 'error')
  assert.equal(f.errors[0].detail, 'refine_failed')
  assert.equal(f.states.at(-1).isRefining, false)
  assert.equal(f.broadcasts[0][0], 'audio_processing_error')
  assert.equal(f.results.length, 0)
  assert.ok(f.calls.some(c => c.channel === 'db:history-upsert-mode-meta' && c.payload.modeMetaPatch.raw_text === '原文'))
  f.transport.cleanup()
})

for (const failure of ['missing_audio', 'compression_rejects', 'provider_rejects']) {
  test(`${failure} reaches the UI error handler`, async () => {
    const f = fixture(failure === 'provider_rejects'
      ? { 'audio:ai-voice-flow': () => { throw new Error('network_failed') } }
      : { 'audio:opus-compress-by-audio-id': () => { if (failure === 'compression_rejects') throw new Error('encoding_failed'); return {} } })
    f.transport.sendMessage('audio', { type: 'end_audio' })
    assert.equal(await f.outcome.promise, 'error')
    assert.equal(f.errors.length, 1)
    assert.equal(f.states.at(-1).isRefining, false)
    f.transport.cleanup()
  })
}

for (const phase of ['compression', 'provider']) {
  test(`cancellation during ${phase} aborts and suppresses late results`, async () => {
    const pending = deferred()
    const f = fixture({ [phase === 'compression' ? 'audio:opus-compress-by-audio-id' : 'audio:ai-voice-flow']: () => pending.promise })
    f.transport.sendMessage('audio', { type: 'end_audio' })
    await tick()
    f.transport.interruptSession('audio')
    pending.resolve(phase === 'compression' ? { outputArrayBuffer: new Uint8Array([1]) } : { success: true, refine_text: 'late' })
    await tick()
    assert.equal(f.results.length, 0)
    assert.equal(f.errors.length, 0)
    assert.ok(f.calls.some(c => c.channel === 'audio:abort-ai-voice-flow-request'))
    if (phase === 'compression') assert.ok(!f.calls.some(c => c.channel === 'audio:ai-voice-flow'))
    assert.equal(f.states.at(-1).isRefining, false)
    f.transport.cleanup()
  })
}

test('retry uses the same abortable lifecycle and ignores a superseded request', async () => {
  const old = deferred(); let attempts = 0
  const f = fixture({ 'audio:ai-voice-flow': () => ++attempts === 1 ? old.promise : { success: true, refine_text: 'retry result' } })
  f.transport.sendMessage('audio', { type: 'end_audio' })
  await tick()
  await f.transport.sendRetryRequest('audio')
  old.resolve({ success: true, refine_text: 'stale result' })
  await tick()
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].refinedText, 'retry result')
  const requests = f.calls.filter(c => c.channel === 'audio:ai-voice-flow')
  assert.equal(requests[1].payload.isRetry, true)
  assert.notEqual(requests[0].payload.abortId, requests[1].payload.abortId)
  f.transport.cleanup()
})

test('unresponsive IPC has a bounded deadline and an abort request', async () => {
  const f = fixture({ 'audio:ai-voice-flow': () => new Promise(() => {}) }, 20)
  f.transport.sendMessage('audio', { type: 'end_audio' })
  assert.equal(await f.outcome.promise, 'error')
  assert.equal(f.errors[0].detail, 'voice_request_timeout')
  assert.ok(f.calls.some(c => c.channel === 'audio:abort-ai-voice-flow-request'))
  f.transport.cleanup()
})

test('paywall stops processing without a fake transcript', async () => {
  const f = fixture({ 'audio:ai-voice-flow': () => ({ success: false, paywall: { type: 'paywall' } }) })
  f.transport.sendMessage('audio', { type: 'end_audio' })
  assert.equal(await f.outcome.promise, 'paywall')
  assert.equal(f.states.at(-1).isRefining, false)
  assert.equal(f.results.length, 0)
  f.transport.cleanup()
})

test('cleanup cancels every request without late callbacks', async () => {
  const pending = deferred(), f = fixture({ 'audio:ai-voice-flow': () => pending.promise })
  f.transport.sendMessage('audio', { type: 'end_audio' })
  await tick()
  f.transport.cleanup()
  pending.resolve({ success: true, refine_text: 'late' })
  await tick()
  assert.equal(f.destroyed, true)
  assert.equal(f.transport.getReadyState(), 3)
  assert.equal(f.results.length + f.errors.length + f.broadcasts.length, 0)
})
