import assert from 'node:assert/strict'
import {
  CaptureSession,
  type CaptureSessionDeps,
} from '../src/main/services/capture-session'
import type { HistoryInsert, HistoryRow } from '../src/main/db'
import type {
  TranscribeParams,
  TranscribeResult,
} from '../src/main/services/providers/types'
import type { VoiceState } from '../src/shared/desktop'
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
function fixture(overrides: Partial<CaptureSessionDeps> = {}) {
  const states: VoiceState[] = [],
    rows = new Map<string, HistoryInsert>(),
    requests: TranscribeParams[] = [],
    injected: string[] = [],
    cards: string[] = [],
    audio = new Map<string, Uint8Array>()
  let changed = 0
  const deps: CaptureSessionDeps = {
    provider: {
      name: 'test',
      transcribe: async (p) => {
        requests.push(p)
        return { success: true, text: 'final', rawText: 'raw' }
      },
    },
    getConfig: () => ({
      mode: 'voice_transcript',
      outputLanguage: 'en',
      asrLanguage: 'zh',
      autoInject: true,
      blacklistDomains: [],
      appVersion: 'test',
    }),
    context: () => ({
      appName: 'Editor',
      bundleId: 'test.editor',
      selectedText: 'selected',
      audioContext: { input_context: 'context' },
    }),
    notify: (s) => states.push(s),
    flush: async () => {},
    saveAudio: async (id, bytes) => {
      audio.set(id, bytes)
      return '/audio/' + id + '.wav'
    },
    saveHistory: async (row) => {
      rows.set(row.id, { ...rows.get(row.id), ...row })
    },
    loadHistory: async (id) => (rows.get(id) as HistoryRow) ?? null,
    inject: async (text) => {
      injected.push(text)
    },
    showCard: (text) => { cards.push(text) },
    changed: () => changed++,
    personalization: async () => ({
      dictionary: [{ term: 'OpenType' }],
      style: 'concise',
    }),
    ...overrides,
  }
  const session = new CaptureSession(deps)
  return {
    session,
    deps,
    states,
    rows,
    requests,
    injected,
    cards,
    audio,
    changed: () => changed,
  }
}
let passed = 0
async function test(name: string, fn: () => Promise<void>) {
  await fn()
  passed++
  console.log('OK ' + name)
}
await test('flush acknowledgement includes final samples and saves WAV before inference', async () => {
  const f = fixture({
    flush: async () => f.session.pushAudio(new Float32Array(1600), 16000, 0),
  })
  const start = await f.session.onStart()
  f.session.pushAudio(new Float32Array(6400), 16000, 0)
  await f.session.onStop()
  assert.equal(f.requests[0].duration, 0.5)
  assert.equal(f.audio.get(start!.audioId)?.length, 16044)
  assert.deepEqual(f.injected, ['final'])
  assert.equal(f.rows.get(start!.audioId)?.status, 'completed')
  assert.equal(
    JSON.parse(String(f.rows.get(start!.audioId)?.modeMeta)).raw_text,
    'raw',
  )
  assert.equal(f.changed(), 1)
  assert.equal(f.session.isBusy, false)
})
await test('stop is idempotent while waiting for microphone flush', async () => {
  const flush = deferred<void>()
  const f = fixture({ flush: () => flush.promise })
  await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  const first = f.session.onStop()
  assert.equal(await f.session.onStop(), null)
  assert.equal(await f.session.onStart(), null)
  flush.resolve()
  await first
  assert.equal(f.requests.length, 1)
})
await test('cancel during flush prevents any request or insertion', async () => {
  const flush = deferred<void>()
  const f = fixture({ flush: () => flush.promise })
  await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  const stop = f.session.onStop()
  f.session.onCancel()
  flush.resolve()
  await stop
  assert.equal(f.requests.length, 0)
  assert.equal(f.injected.length, 0)
})
await test('cancelled late provider cannot inject or reset a newer session', async () => {
  const result = deferred<TranscribeResult>(),
    entered = deferred<void>()
  const f = fixture({
    provider: {
      name: 'delayed',
      transcribe: async () => {
        entered.resolve()
        return result.promise
      },
    },
  })
  const first = await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  const stop = f.session.onStop()
  await entered.promise
  f.session.onCancel()
  const second = await f.session.onStart()
  assert.notEqual(first!.audioId, second!.audioId)
  result.resolve({ success: true, text: 'late' })
  await stop
  assert.equal(f.injected.length, 0)
  assert.equal(f.session.isBusy, true)
  assert.equal(f.rows.get(first!.audioId)?.status, 'cancelled')
  f.session.onCancel()
})
await test('failure preserves audio and raw text for retry', async () => {
  const f = fixture({
    provider: {
      name: 'fail',
      transcribe: async () => ({
        success: false,
        rawText: 'recognised original',
        detail: 'refine_failed',
      }),
    },
  })
  const start = await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert(f.audio.has(start!.audioId))
  assert.equal(f.rows.get(start!.audioId)?.status, 'failed')
  assert.equal(
    JSON.parse(String(f.rows.get(start!.audioId)?.modeMeta)).raw_text,
    'recognised original',
  )
  assert.equal(f.injected.length, 0)
})
await test('thrown network error still retains recording and failed history', async () => {
  const f = fixture({
    provider: {
      name: 'throw',
      transcribe: async () => {
        throw new Error('offline')
      },
    },
  })
  const start = await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert(f.audio.has(start!.audioId))
  assert.equal(f.rows.get(start!.audioId)?.status, 'failed')
  assert.equal(f.states.at(-1)?.detail, 'offline')
})
await test('frozen mode, target language, context, dictionary and style reach provider', async () => {
  let mode = 'voice_translation'
  const f = fixture({
    getConfig: () => ({
      mode: mode as 'voice_translation',
      outputLanguage: 'ja',
      asrLanguage: 'zh',
      autoInject: false,
      blacklistDomains: [],
      appVersion: 'test',
    }),
  })
  await f.session.onStart()
  mode = 'voice_transcript'
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert.equal(f.requests[0].mode, 'voice_translation')
  assert.equal(f.requests[0].parameters?.output_language, 'ja')
  assert.deepEqual(f.requests[0].parameters?.dictionary, [{ term: 'OpenType' }])
  assert.equal(f.requests[0].parameters?.style, 'concise')
  assert.equal(f.injected.length, 0)
})
await test('question without selected text opens answer card', async () => {
  const f = fixture({
    getConfig: () => ({
      mode: 'voice_command',
      outputLanguage: 'en',
      asrLanguage: 'auto',
      autoInject: true,
      blacklistDomains: [],
      appVersion: 'test',
    }),
    context: () => ({
      appName: 'Editor',
      bundleId: 'test',
      selectedText: '',
      audioContext: {},
    }),
  })
  await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert.deepEqual(f.cards, ['final'])
  assert.equal(f.injected.length, 0)
})
await test('flush failure and microphone failure settle and allow recovery', async () => {
  const f = fixture({
    flush: async () => {
      throw new Error('capture_flush_timeout')
    },
  })
  const start = await f.session.onStart()
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert.equal(f.states.at(-1)?.detail, 'capture_flush_timeout')
  assert.equal(f.session.isBusy, false)
  const next = await f.session.onStart()
  f.session.captureFailed(start!.audioId)
  assert(f.session.isBusy)
  f.session.captureFailed(next!.audioId)
  assert.equal(f.session.isBusy, false)
  assert.equal(f.states.at(-1)?.phase, 'error')
})
await test('short utterances are sent to recognition; only empty captures are skipped', async () => {
  const f = fixture()
  await f.session.onStart()
  f.session.pushAudio(new Float32Array(1600), 16000, 0)
  await f.session.onStop()
  assert.equal(f.requests[0].duration, 0.1)
  await f.session.onStart(); await f.session.onStop()
  assert.equal(f.requests.length, 1)
  assert.equal(f.states.at(-1)?.detail, 'empty_audio')
})
await test('recording beyond nine minutes remains active until the user stops', async () => {
  const f = fixture()
  await f.session.onStart()
  f.session.pushAudio(new Float32Array(16000 * 541), 16000, 0)
  assert.equal(f.states.at(-1)?.phase, 'recording')
  assert.equal(f.requests.length, 0)
  await f.session.onStop()
  assert.equal(f.requests[0].duration, 541)
})

await test('capture freezes target and output preferences; stop formats once and keeps ASR original', async () => {
  let current = { punctuation: 'chinese', spacing: 'space', expression: 'formal' }
  const seen: string[] = []
  const f = fixture({
    personalization: async target => { seen.push(target.bundleId); return { output_preferences: { ...current } } },
    provider: { name: 'test', transcribe: async p => { f.requests.push(p); return { success: true, text: '中文API,好.', rawText: 'ASR原文' } } },
  })
  const first = await f.session.onStart()
  current = { punctuation: 'preserve', spacing: 'compact', expression: 'casual' }
  f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert.deepEqual(seen, ['test.editor'])
  assert.deepEqual(f.injected, ['中文 API，好。'])
  assert.equal(f.rows.get(first!.audioId)?.refinedText, '中文 API，好。')
  assert.equal(JSON.parse(String(f.rows.get(first!.audioId)?.modeMeta)).raw_text, 'ASR原文')
  assert.equal((f.requests[0].parameters?.output_preferences as any).expression, 'formal')
  const retry = await f.session.voiceFlowForRenderer({ audioId: first!.audioId, arrayBuffer: new Uint8Array([1]), isRetry: true })
  assert.equal(retry.refine_text, '中文API,好.')
  assert.equal(retry.raw_text, 'ASR原文')
  assert.deepEqual(seen, ['test.editor', 'test.editor'])
  assert.equal((f.requests[1].parameters?.output_preferences as any).expression, 'casual')
})
await test('live recognition follows the same formatting path without falling back or double insertion', async () => {
  let finishes = 0
  const f = fixture({
    personalization: async () => ({ output_preferences: { punctuation: 'chinese', spacing: 'space', expression: 'original' } }),
    provider: { name: 'live', transcribe: async () => { throw new Error('unexpected single shot') },
      startLiveTranscription: () => ({ pushAudio() {}, seal() {}, dispose() {},
        async finish() { finishes++; return { success: true, text: '中文ABC,尾段.', rawText: 'raw' } } }) },
  })
  await f.session.onStart(); f.session.pushAudio(new Float32Array(8000), 16000, 0)
  await f.session.onStop()
  assert.deepEqual(f.injected, ['中文 ABC，尾段。'])
  assert.equal(finishes, 1)
})
await test('retry keeps provider snapshot across pending personalization; cancellation never calls provider', async () => {
  for (const cancel of [false, true]) {
    const barrier = deferred<Record<string, unknown>>(), entered = deferred<void>()
    let first = 0, second = 0
    const f = fixture({
      personalization: async () => { entered.resolve(); return barrier.promise },
      provider: { name: 'first', transcribe: async () => { first++; return { success: true, text: 'first' } } },
    })
    const retry = f.session.voiceFlowForRenderer({ audioId: 'retry', abortId: 'pending', arrayBuffer: new Uint8Array([1]) })
    await entered.promise
    f.session.setProvider({ name: 'second', transcribe: async () => { second++; return { success: true, text: 'second' } } })
    if (cancel) f.session.cancelByAbortId('pending')
    barrier.resolve({})
    const result = await retry
    assert.equal(first, cancel ? 0 : 1)
    assert.equal(second, 0)
    assert.equal(result.success, !cancel)
  }
})
await test('cancelled capture observes a later personalization rejection without starting recognition', async () => {
  let reject!: (error: Error) => void
  const f = fixture({ personalization: () => new Promise((_, r) => { reject = r }) })
  await f.session.onStart(); f.session.onCancel(); reject(new Error('dictionary unavailable'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.requests.length, 0)
  assert.equal(f.session.isBusy, false)
})


await test('failed input preserves successful recognition and raw history, exposes copy fallback and releases target', async () => {
  const fallback: string[] = [], released: string[] = []
  const f = fixture({ context: () => ({ appName: 'Editor', bundleId: 'test.editor', audioContext: {}, selectedText: '', inputToken: 'private-token' }),
    inject: async () => { throw new Error('injection_target_changed') }, showFallback: text => fallback.push(text),
    releaseTarget: target => released.push(target.inputToken!) })
  const start=await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);const result=await f.session.onStop()
  assert.equal(result?.success,true);assert.equal(result?.delivery,'manual');assert.deepEqual(fallback,['final']);assert.deepEqual(released,['private-token'])
  const row=f.rows.get(start!.audioId)!;assert.equal(row.status,'completed');assert.equal(row.refinedText,'final');assert.equal(JSON.parse(String(row.modeMeta)).raw_text,'raw');assert.equal(JSON.parse(String(row.modeMeta)).input_delivery,'failed')
  assert(!JSON.stringify(row).includes('private-token'));assert.equal(f.states.at(-1)?.phase,'error')
})
await test('verified and uncertain delivery states persist without offering duplicate paste', async () => {
  for(const status of ['verified','unverified'] as const){
    const fallback: string[]=[]
    const f=fixture({inject:async()=>({status,method:'clipboard',detail:status==='unverified'?'injection_unverified':undefined}),showFallback:text=>fallback.push(text)})
    const start=await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);await f.session.onStop()
    assert.equal(JSON.parse(String(f.rows.get(start!.audioId)?.modeMeta)).input_delivery,status);assert.equal(fallback.length,0);assert.equal(f.states.at(-1)?.phase,'done')
  }
})
await test('cancellation after sending retains delivery status and does not touch a newer session', async () => {
  const entered=deferred<void>(),wait=deferred<void>()
  const f=fixture({inject:async()=>{entered.resolve();await wait.promise;return {status:'unverified',method:'clipboard',detail:'injection_cancelled_after_send'}}})
  const first=await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);const stop=f.session.onStop();await entered.promise
  f.session.onCancel();await f.session.onStart();wait.resolve();const result=await stop
  assert.equal(result?.success,true);assert.equal(f.rows.get(first!.audioId)?.status,'completed');assert.equal(f.session.isRecording,true);f.session.onCancel()
})
await test('history write failure after successful injection never offers a duplicate paste fallback', async () => {
  const f=fixture({inject:async()=>({status:'verified',method:'accessibility'}),showFallback:()=>{throw new Error('must not offer duplicate paste')}})
  const base=f.deps.saveHistory;f.deps.saveHistory=async row=>{if(String(row.modeMeta).includes('input_delivery'))throw new Error('disk full');await base(row)}
  await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);const result=await f.session.onStop()
  assert.equal(result?.success,true);assert.equal(result?.detail,'injection_history_save_failed')
})
await test('question with editable selected text shows a review card without automatic insertion and transfers target ownership', async () => {
  const released: string[] = [], modes: string[] = []
  const f = fixture({getConfig:()=>({mode:'voice_command',outputLanguage:'en',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
    context:mode=>{modes.push(mode);return {appName:'Editor',bundleId:'test.editor',audioContext:{},selectedText:'selected original',inputToken:'held-target'}},
    showCard:(text,id,target)=>{f.cards.push(text);assert.equal(target.inputToken,'held-target');assert(id);return true},releaseTarget:t=>released.push(t.inputToken!)})
  const start=await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);const result=await f.session.onStop()
  assert.equal(result?.delivery,'card');assert.deepEqual(f.injected,[]);assert.deepEqual(f.cards,['final']);assert.deepEqual(released,[]);assert.deepEqual(modes,['voice_command'])
  assert.equal(JSON.parse(String(f.rows.get(start!.audioId)?.modeMeta)).selected_text,'selected original')
  assert(!JSON.stringify([...f.rows.values()]).includes('held-target'))
})
await test('preview captures dictation context and non-retained question targets are released', async () => {
  const modes:string[]=[];const released:string[]=[]
  const f=fixture({getConfig:()=>({mode:'voice_command',outputLanguage:'en',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
    context:mode=>{modes.push(mode);return {appName:'Readonly',bundleId:'test.readonly',audioContext:{},selectedText:'selected article'}},releaseTarget:()=>released.push('released')})
  await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);await f.session.onStop();assert.deepEqual(f.cards,['final']);assert.equal(released.length,1)
  await f.session.onStart({preview:true});f.session.onCancel();assert.deepEqual(modes,['voice_command','voice_transcript']);assert.equal(released.length,2)
})
await test('only saved verified dictation transfers its target to optional input correction tracking', async () => {
  for (const mode of ['voice_transcript', 'voice_translation', 'voice_command'] as const) for (const status of ['verified', 'unverified'] as const) {
    let observed = 0, released = 0
    const f = fixture({ getConfig: () => ({mode,outputLanguage:'en',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
      inject: async () => ({status,method:'clipboard'}), releaseTarget: () => { released++ },
      observeInput: (id, text) => { observed++; assert.equal(JSON.parse(String(f.rows.get(id)?.modeMeta)).input_delivery,'verified'); assert.equal(text,'final'); return true } })
    await f.session.onStart(); f.session.pushAudio(new Float32Array(8000),16000,0); await f.session.onStop(); f.session.dispose()
    const expected = mode === 'voice_transcript' && status === 'verified'
    assert.equal(observed, expected ? 1 : 0); assert.equal(released, expected ? 0 : 1)
  }
})
await test('disabled or failed-to-save observations retain normal target cleanup', async () => {
  for (const failSave of [false,true]) {
    let observed=0,released=0
    const f=fixture({inject:async()=>({status:'verified',method:'clipboard'}),observeInput:()=>{observed++;return false},releaseTarget:()=>{released++}})
    const save=f.deps.saveHistory;f.deps.saveHistory=async row=>{if(failSave&&String(row.modeMeta).includes('input_delivery'))throw new Error('disk full');await save(row)}
    await f.session.onStart();f.session.pushAudio(new Float32Array(8000),16000,0);await f.session.onStop()
    assert.equal(observed,failSave?0:1);assert.equal(released,1)
  }
})
console.log(`${passed} capture session scenarios passed`)
