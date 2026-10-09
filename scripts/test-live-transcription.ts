import assert from 'node:assert/strict'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { PauseSegmenter } from '../src/main/services/local-asr/pause-segmenter'
import { LiveLocalTranscription } from '../src/main/services/local-asr/live-transcription'
import { NativeLocalProvider } from '../src/main/services/providers/native-local'
import { CaptureSession, type CaptureSessionDeps } from '../src/main/services/capture-session'
import { encodeWav } from '../src/main/services/pcm'
import type { VoiceState } from '../src/shared/desktop'

const rate = 16000
const silence = (seconds: number) => new Float32Array(Math.round(seconds * rate))
const speech = (seconds: number, gain = .1) => Float32Array.from(silence(seconds), (_, i) => gain * Math.sin(i * .13))
function concat(parts: Float32Array[]) {
  const data = new Float32Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) { data.set(part, offset); offset += part.length }
  return data
}
const phrase = concat([speech(2), silence(.7)])
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
let count = 0
async function test(name: string, run: () => void | Promise<void>) {
  await run(); count++; console.log('OK ' + name)
}

await test('natural pauses close a segment before stop; short hesitations do not split speech', () => {
  const parts: Float32Array[] = []
  const segmenter = new PauseSegmenter(p => parts.push(p))
  segmenter.push(concat([speech(2), silence(.3), speech(1)]))
  assert.equal(parts.length, 0)
  segmenter.push(silence(.7))
  assert.equal(parts.length, 1)
  assert.equal(parts[0].length, 4 * rate)
  segmenter.push(speech(.08)); segmenter.flush(); segmenter.flush()
  assert.equal(parts.length, 2)
  assert.equal(parts[1].length, .08 * rate)
})

await test('arbitrary IPC boundaries, soft speech and 541 seconds without pauses preserve every sample once', () => {
  for (const source of [concat([silence(1), phrase, speech(.2, .002), silence(2), speech(.1)]), speech(541)]) {
    const segment = (size: number) => {
      const parts: Float32Array[] = []
      const segmenter = new PauseSegmenter(p => parts.push(p))
      for (let at = 0; at < source.length; at += size) segmenter.push(source.subarray(at, at + size))
      segmenter.flush()
      assert(parts.every(p => p.length > 0 && p.length <= 25 * rate))
      assert.deepEqual(concat(parts), source)
      return parts.map(p => p.length)
    }
    assert.deepEqual(segment(1024), segment(317))
  }
})

await test('one native inference at a time; finish drains backlog and includes the final short tail exactly once', async () => {
  const first = deferred<{ text: string }>()
  const requests: Uint8Array[] = []
  let active = 0, peak = 0
  const live = new LiveLocalTranscription({ transcribe: async audio => {
    requests.push(audio); peak = Math.max(peak, ++active)
    const result = requests.length === 1 ? await first.promise : { text: '重复。' }
    active--; return result
  } }, new AbortController().signal)
  const source = concat([phrase, phrase, speech(.08)])
  live.pushAudio(source)
  await tick()
  assert.equal(requests.length, 1)
  const result = live.finish()
  assert.equal(live.finish(), result)
  first.resolve({ text: '重复。' })
  assert.deepEqual(await result, { text: '重复。重复。重复。' })
  assert.equal(peak, 1)
  assert.equal(requests.length, 3)
  assert.deepEqual(Buffer.concat(requests.map(p => Buffer.from(p.subarray(44)))), Buffer.from(encodeWav([source], rate).subarray(44)))
  live.pushAudio(phrase)
  assert.equal(requests.length, 3)
  live.dispose()
})

await test('a failed background segment is retried in place, preserving order and successful work', async () => {
  let calls = 0
  const live = new LiveLocalTranscription({ transcribe: async () => {
    calls++
    return calls === 1 ? { error: 'local_asr_crashed' } : { text: calls === 2 ? '第二句。' : '第一句。' }
  } }, new AbortController().signal)
  live.pushAudio(concat([phrase, phrase]))
  await tick()
  assert.equal(calls, 2)
  assert.deepEqual(await live.finish(), { text: '第一句。第二句。' })
  assert.equal(calls, 3)
  live.dispose()
})

await test('persistent errors and thrown jobs produce failure, never a partial successful transcript', async () => {
  for (const result of [{ error: 'local_asr_failed' }, {}]) {
    let calls = 0
    const live = new LiveLocalTranscription({ transcribe: async () => {
      if (++calls === 1) throw new Error('native died')
      return result
    } }, new AbortController().signal)
    live.pushAudio(phrase)
    await tick()
    assert.deepEqual(await live.finish(), { error: 'local_asr_failed' })
    assert.equal(calls, 2)
    live.dispose()
  }
})

await test('cancellation and disposal abort native work, discard queued audio and ignore late results', async () => {
  for (const cancel of ['abort', 'dispose']) {
    const first = deferred<{ text: string }>(), controller = new AbortController()
    let calls = 0, nativeSignal: AbortSignal | undefined
    const live = new LiveLocalTranscription({ transcribe: async (_audio, signal) => {
      calls++; nativeSignal = signal; return first.promise
    } }, controller.signal)
    live.pushAudio(concat([phrase, phrase]))
    await tick()
    if (cancel === 'abort') controller.abort(); else live.dispose()
    assert(nativeSignal?.aborted)
    first.resolve({ text: 'obsolete' })
    assert.deepEqual(await live.finish(), { error: 'cancelled' })
    await tick()
    assert.equal(calls, 1)
  }
})

function fixture(provider: CaptureSessionDeps['provider'], overrides: Partial<CaptureSessionDeps> = {}) {
  const inserted: string[] = [], states: VoiceState[] = [], recordings: Uint8Array[] = []
  const records: Array<Record<string, unknown>> = []
  const session = new CaptureSession({
    provider, getConfig: () => ({ mode: 'voice_transcript', outputLanguage: 'en', asrLanguage: 'zh',
      autoInject: true, blacklistDomains: [], appVersion: 'test' }),
    context: () => ({ appName: 'Editor', bundleId: 'test.editor', audioContext: {}, selectedText: '' }),
    notify: s => states.push(s), flush: async () => {},
    saveAudio: async (_id, data) => { recordings.push(data); return '/test/audio.wav' },
    saveHistory: async r => { records.push(r) }, loadHistory: async () => null,
    inject: async text => { inserted.push(text) }, showCard: () => {}, changed: () => {},
    personalization: async () => ({ dictionary: [{ term: 'OpenType' }] }), ...overrides,
  })
  return { session, inserted, states, recordings, records }
}
const refinement = { provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'test',
  enabled: true, apiKey: 'synthetic-only' }
const original = getGlobalDispatcher(), mock = new MockAgent()
mock.disableNetConnect(); setGlobalDispatcher(mock)
try {
  await test('capture precomputes ASR; one whole-text refinement and one insertion happen only after microphone tail flush', async () => {
    const jobs: Uint8Array[] = []
    let refined = 0
    mock.get('https://api.deepseek.com').intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
      refined++
      const data = JSON.parse(JSON.parse(String(options.body)).messages[1].content)
      assert.equal(data.transcript, '第一句。第二句。尾句。')
      assert.deepEqual(data.dictionary, [{ term: 'OpenType' }])
      return { statusCode: 200, data: { choices: [{ finish_reason: 'stop', message: { content: '完整整理结果。' } }] } }
    })
    const provider = new NativeLocalProvider({ transcribe: async audio => {
      jobs.push(audio); return { text: ['第一句。', '第二句。', '尾句。'][jobs.length - 1] }
    } }, refinement)
    const saved = deferred<void>(), saving = deferred<void>()
    const f = fixture(provider, {
      flush: async () => f.session.pushAudio(speech(.08), rate, 0, id),
      saveAudio: async (_id, data) => {
        f.recordings.push(data); saving.resolve(); await saved.promise; return '/test/audio.wav'
      },
    })
    const id = (await f.session.onStart())!.audioId
    f.session.pushAudio(concat([phrase, phrase]), rate, 0, id)
    await tick()
    assert.equal(jobs.length, 2)
    assert.equal(refined, 0)
    assert.equal(f.inserted.length, 0)
    assert.equal(f.states.at(-1)?.phase, 'recording')
    // Editing provider settings mid-recording must not discard or mix existing ASR.
    f.session.setProvider({ name: 'changed', transcribe: async () => { throw new Error('wrong provider') } })
    const stopping = f.session.onStop()
    await saving.promise; await tick()
    assert.equal(jobs.length, 3, 'Tail inference overlaps recording persistence')
    f.session.pushAudio(phrase, rate, 0, id) // Late messages after the ACK are ignored.
    saved.resolve()
    assert.equal((await stopping)?.success, true)
    assert.equal(jobs.length, 3)
    assert.equal(refined, 1)
    assert.deepEqual(f.inserted, ['完整整理结果。'])
    assert.deepEqual(f.recordings[0], encodeWav([phrase, phrase, speech(.08)], rate))
    assert.equal(JSON.parse(String(f.records.at(-1)?.modeMeta)).raw_text, '第一句。第二句。尾句。')
    f.session.dispose()
  })

  await test('cancel during capture isolates the next session from old PCM and late ASR; no early refinement', async () => {
    const first = deferred<{ text: string }>()
    let calls = 0
    const provider = new NativeLocalProvider({ transcribe: async () => ++calls === 1 ? first.promise : { text: '新录音。' } }, { ...refinement, enabled: false })
    const f = fixture(provider)
    const old = (await f.session.onStart())!.audioId
    f.session.pushAudio(phrase, rate, 0, old)
    await tick(); f.session.onCancel()
    const next = (await f.session.onStart())!.audioId
    f.session.pushAudio(phrase, rate, 0, old)
    f.session.pushAudio(phrase, rate, 0, next)
    first.resolve({ text: '旧录音。' })
    await tick()
    assert.equal((await f.session.onStop())?.text, '新录音。')
    assert.equal(calls, 2)
    assert.deepEqual(f.inserted, ['新录音。'])
    assert.deepEqual(f.recordings[0], encodeWav([phrase], rate))
    f.session.dispose()
  })

  await test('failed ASR preserves the entire recording for retry and does not refine or insert partial text', async () => {
    let calls = 0
    const provider = new NativeLocalProvider({ transcribe: async () => ++calls === 1 ? { text: '只有前半句。' } : { error: 'local_asr_failed' } }, refinement)
    const f = fixture(provider)
    await f.session.onStart(); f.session.pushAudio(concat([phrase, phrase]), rate, 0)
    await tick()
    assert.equal((await f.session.onStop())?.success, false)
    assert.equal(calls, 3)
    assert.equal(f.inserted.length, 0)
    assert.equal(f.records.at(-1)?.status, 'failed')
    assert.deepEqual(f.recordings[0], encodeWav([phrase, phrase], rate))
    f.session.dispose()
  })
  mock.assertNoPendingInterceptors()
} finally { setGlobalDispatcher(original); await mock.close() }
console.log(`${count} live transcription scenarios passed`)
