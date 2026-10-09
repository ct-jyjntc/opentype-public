import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioSegments, joinTranscripts } from '../src/main/services/local-asr/segments'
import { LocalAsrProcess } from '../src/main/services/local-asr/process'
import { SenseVoiceModelStore } from '../src/main/services/local-asr/model-store'
import { decodeLocalAudio } from '../src/main/services/local-asr/audio-decode'
import { encodeWav } from '../src/main/services/pcm'

class Child extends EventEmitter {
  killed = false
  job: any
  postMessage(job: unknown) { this.job = job }
  kill() { this.killed = true; this.emit('exit') }
}
const children: Child[] = []
const engine = new LocalAsrProcess(() => { const child = new Child(); children.push(child); return child }, '/synthetic/model', 25, 25)
try {
  const request = engine.transcribe(new Uint8Array([1]))
  const a = children[0]
  assert.equal((await engine.transcribe(new Uint8Array([2]))).error, 'local_asr_busy')
  a.emit('message', { id: a.job.id + 1, text: 'wrong-id' })
  a.emit('message', { id: a.job.id, text: 'correct' })
  assert.equal((await request).text, 'correct')
  const hung = engine.transcribe(new Uint8Array([3]))
  assert.equal((await hung).error, 'local_asr_timeout'); assert(a.killed)
  const restart = engine.transcribe(new Uint8Array([4]))
  assert.equal(children.length, 2)
  a.emit('message', { id: children[1].job.id, text: 'stale-child' })
  children[1].emit('exit')
  assert.equal((await restart).error, 'local_asr_crashed')
  const abort = new AbortController(), pending = engine.transcribe(new Uint8Array([5]), abort.signal)
  abort.abort(); assert.equal((await pending).error, 'cancelled'); assert(children[2].killed)
  assert.equal((await engine.transcribe(new Uint8Array([1]), AbortSignal.abort())).error, 'cancelled')
  console.log('OK process timeout, crash, bounded concurrency, stale IDs/children, cancellation and restart')
} finally { engine.dispose() }

const wav = encodeWav([new Float32Array([0, .25, -.25, 1])], 16000)
const decoded = await decodeLocalAudio(wav)
assert.equal(decoded.sampleRate, 16000); assert.equal(decoded.samples.length, 4)
assert(Math.abs(decoded.samples[1] - .25) < .0001)
const broken = wav.slice(); new DataView(broken.buffer).setUint32(40, 999999, true)
await assert.rejects(decodeLocalAudio(broken), /invalid_audio/)
const long = await decodeLocalAudio(encodeWav([new Float32Array(541 * 16000)], 16000))
assert.equal(long.samples.length, 541 * 16000)
const chunks = [...audioSegments(long.samples, long.sampleRate)]
assert(chunks.every(chunk => chunk.length > 0 && chunk.length <= 25 * 16000))
assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), long.samples.length)
assert.equal(joinTranscripts(['Hello', 'world.', 'Next']), 'Hello world. Next')
assert.equal(joinTranscripts(['今天', '开会。']), '今天开会。')
console.log('OK WAV longer than nine minutes decodes fully; inference windows preserve every sample')
const progressChild = new Child()
const progressEngine = new LocalAsrProcess(() => progressChild, '/test', 50, 1000)
const progressJob = progressEngine.transcribe(new Uint8Array([1]))
for (let i = 0; i < 5; i++) {
  await new Promise(r => setTimeout(r, 20))
  progressChild.emit('message', {id: progressChild.job.id, progress:true})
}
progressChild.emit('message', {id:progressChild.job.id, text:'long finished'})
assert.equal((await progressJob).text, 'long finished')
progressEngine.dispose()
console.log('OK progressing long inference can exceed the stall timeout; stalled jobs still time out')

const dir = mkdtempSync(join(tmpdir(), 'opentype-model-store-test-'))
const previousFetch = globalThis.fetch
try {
  const models = new SenseVoiceModelStore(dir)
  assert.equal((await models.check()).state, 'missing')
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]))
  assert.equal((await models.install()).state, 'error')
  assert.deepEqual(readdirSync(dir), [])
  let downloads = 0
  globalThis.fetch = async (_url, options) => {
    downloads++
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  const pending = models.install()
  assert.equal(models.install(), pending)
  await new Promise(resolve => setTimeout(resolve, 10))
  models.dispose()
  assert.equal((await pending).state, 'error'); assert.equal(downloads, 1)
  assert.deepEqual(readdirSync(dir), [])
  writeFileSync(join(dir, 'tokens.txt'), 'invalid existing tokens')
  assert.equal((await models.check()).state, 'error')
  console.log('OK model download size validation, partial cleanup, deduplication, cancellation and retryable state')
} finally { globalThis.fetch = previousFetch; rmSync(dir, { recursive: true, force: true }) }
