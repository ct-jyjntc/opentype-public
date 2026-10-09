import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, closeDatabase, HistoryRepo } from '../src/main/db'
import { HistoryLifecycle } from '../src/main/services/history-lifecycle'
import { CaptureSession, type CaptureSessionDeps } from '../src/main/services/capture-session'
import type { TranscribeParams, TranscribeResult } from '../src/main/services/providers/types'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
let passed = 0
async function test(name: string, run: (dir: string, audio: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'opentype-history-lifecycle-'))
  const audio = join(dir, 'audio')
  await mkdir(audio)
  initDatabase(join(dir, 'db'))
  try { await run(dir, audio); passed++; console.log('OK ' + name) }
  finally { closeDatabase(); await rm(dir, { recursive: true, force: true }) }
}
const put = (id: string, createdAt = new Date().toISOString()) => HistoryRepo.upsert({
  id, createdAt, status: 'completed', refinedText: 'synthetic test text',
})
const lifecycle = (audio: string) => new HistoryLifecycle(audio, () => {}, () => {})

await test('delete removes every owned audio format and blocks stale sync/upsert', async (dir, audio) => {
  const external = join(dir, 'unrelated.txt')
  await writeFile(external, 'keep')
  await put('sample')
  await HistoryRepo.setAudioPath('sample', external)
  const cancelled: string[] = []
  let changes = 0
  const life = new HistoryLifecycle(audio, id => cancelled.push(id), () => changes++)
  for (const ext of ['wav', 'ogg', 'webm']) await life.saveAudio('sample', ext, Buffer.from('audio'))
  await life.remove('sample')
  assert.deepEqual(await readdir(audio), [])
  assert.equal(await readFile(external, 'utf8'), 'keep')
  assert.equal(await HistoryRepo.byId('sample'), null)
  assert.deepEqual(cancelled, ['sample'])
  assert.equal(changes, 1)
  await put('sample')
  assert.equal(await HistoryRepo.applyRemote([{ id: 'sample', refined_text: 'stale' }]), 0)
  assert.equal(await HistoryRepo.byId('sample'), null)
  await assert.rejects(life.saveAudio('sample', 'wav', Buffer.from('late')), /record_deleted/)
  await life.remove('sample')
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), [])
})
await test('filesystem failure is durable and resumes after database restart', async (dir, audio) => {
  await put('locked')
  await writeFile(join(audio, 'locked.wav'), 'audio')
  const broken = new HistoryLifecycle(audio, () => {}, () => {}, async path => {
    if (path.endsWith('.wav')) throw Object.assign(new Error('locked'), { code: 'EACCES' })
    await unlink(path)
  })
  await assert.rejects(broken.remove('locked'), /audio_cleanup_pending/)
  assert.equal(await HistoryRepo.byId('locked'), null)
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), ['locked'])
  closeDatabase()
  initDatabase(join(dir, 'db'))
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), ['locked'])
  await lifecycle(audio).purgeOlderThan(-1)
  assert.deepEqual(await readdir(audio), [])
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), [])
  assert.equal(await HistoryRepo.isDeleted('locked'), true)
})
await test('cleanup failures remain visible even without an active retention limit', async (_dir, audio) => {
  await put('failed')
  const broken = new HistoryLifecycle(audio, () => {}, () => {}, async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })
  await assert.rejects(broken.remove('failed'), /audio_cleanup_pending/)
  await assert.rejects(broken.purgeOlderThan(-1), /audio_cleanup_pending/)
})
await test('clear spans multiple cleanup pages and preserves unrelated files', async (_dir, audio) => {
  const ids = Array.from({ length: 215 }, (_, i) => `batch-${String(i).padStart(3, '0')}`)
  await Promise.all(ids.map(async id => { await put(id); await writeFile(join(audio, id + '.wav'), 'audio') }))
  await writeFile(join(audio, 'notes.txt'), 'keep')
  const cancelled = new Set<string>()
  const life = new HistoryLifecycle(audio, id => cancelled.add(id), () => {})
  await life.clear()
  assert.equal(cancelled.size, 215)
  assert.equal((await HistoryRepo.stats()).count, 0)
  assert.deepEqual(await readdir(audio), ['notes.txt'])
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), [])
})
await test('retention deletes expired audio, cancels work, and respects disabled/invalid days', async (_dir, audio) => {
  const cancelled: string[] = []
  const life = new HistoryLifecycle(audio, id => cancelled.push(id), () => {})
  await put('old', '2020-01-01T00:00:00+08:00')
  await put('new')
  await life.saveAudio('old', 'wav', Buffer.from('old'))
  await life.saveAudio('new', 'wav', Buffer.from('new'))
  for (const days of [-1, NaN, Infinity]) assert.equal(await life.purgeOlderThan(days), 0)
  assert.equal(await life.purgeOlderThan(7), 1)
  assert.deepEqual(cancelled, ['old'])
  assert.deepEqual(await readdir(audio), ['new.wav'])
  assert.equal(await HistoryRepo.isDeleted('new'), false)
  assert.equal(await HistoryRepo.applyRemote([{ id: 'old', refined_text: 'stale' }]), 0)
})
await test('path validation and untrusted legacy paths never delete outside the audio directory', async (dir, audio) => {
  const life = lifecycle(audio)
  await writeFile(join(dir, 'outside.wav'), 'keep')
  for (const id of ['../outside', '/tmp/file', 'a/b', '', 'a'.repeat(201)]) {
    await assert.rejects(life.remove(id), /invalid_audio_id/)
    await assert.rejects(life.saveAudio(id, 'wav', Buffer.from('bad')), /invalid_audio_id/)
  }
  await assert.rejects(life.saveAudio('sample', '../wav', Buffer.from('bad')), /invalid_audio_format/)
  await put('../outside')
  await life.clear()
  assert.equal(await readFile(join(dir, 'outside.wav'), 'utf8'), 'keep')
})
await test('symlink deletion removes only the link and audio writes refuse symlink targets', async (dir, audio) => {
  const external = join(dir, 'outside.wav')
  await writeFile(external, 'keep')
  await symlink(external, join(audio, 'link.wav'))
  const life = lifecycle(audio)
  await assert.rejects(life.saveAudio('link', 'wav', Buffer.from('overwrite')))
  assert.equal(await readFile(external, 'utf8'), 'keep')
  await life.remove('link')
  assert.equal(await readFile(external, 'utf8'), 'keep')
  assert.deepEqual(await readdir(audio), [])
})
await test('delete waits for a delayed file writer and rejects its late success', async (_dir, audio) => {
  const started = deferred(), release = deferred()
  const life = new HistoryLifecycle(audio, () => {}, () => {}, unlink, async (path, bytes) => {
    started.resolve()
    await release.promise
    await writeFile(path, bytes)
  })
  const writing = assert.rejects(life.saveAudio('race', 'wav', Buffer.from('late')), /record_deleted/)
  await started.promise
  let finished = false
  const removing = life.remove('race').then(() => { finished = true })
  await new Promise<void>(r => setImmediate(r))
  assert.equal(finished, false)
  release.resolve()
  await Promise.all([writing, removing])
  assert.deepEqual(await readdir(audio), [])
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), [])
})
await test('concurrent deletes and format replacement leave no pending or resurrected file', async (_dir, audio) => {
  const life = lifecycle(audio)
  await put('replace')
  await life.saveAudio('replace', 'wav', Buffer.from('wav'))
  await life.saveAudio('replace', 'ogg', Buffer.from('ogg'), true)
  assert.deepEqual(await readdir(audio), ['replace.ogg'])
  await Promise.all(Array.from({ length: 12 }, (_, i) => life.remove(i % 2 ? 'replace' : 'missing')))
  assert.deepEqual(await readdir(audio), [])
  assert.deepEqual(await HistoryRepo.pendingAudioCleanup(), [])
})
await test('delete during real capture finalization cancels inference and blocks text insertion', async (_dir, audio) => {
  const entered = deferred(), result = deferred<TranscribeResult>()
  const injected: string[] = []
  let request: TranscribeParams | undefined
  let capture!: CaptureSession
  const life = new HistoryLifecycle(audio, id => capture.cancelByAbortId(id), () => {})
  const deps: CaptureSessionDeps = {
    provider: { name: 'delayed-test', transcribe: async p => { request = p; entered.resolve(); return result.promise } },
    getConfig: () => ({ mode: 'voice_transcript', outputLanguage: 'zh', asrLanguage: 'zh', autoInject: true, blacklistDomains: [], appVersion: 'test' }),
    context: () => ({ appName: 'Test', bundleId: 'test', audioContext: {}, selectedText: '' }),
    notify: () => {}, flush: async () => {},
    saveAudio: (id, data) => life.saveAudio(id, 'wav', data),
    saveHistory: row => HistoryRepo.upsert(row), loadHistory: id => HistoryRepo.byId(id),
    inject: async text => { injected.push(text) }, showCard: text => { injected.push(text) },
    changed: () => {}, personalization: async () => ({}),
  }
  capture = new CaptureSession(deps)
  const start = await capture.onStart()
  capture.pushAudio(new Float32Array(16000), 16000, 0, start!.audioId)
  const stopping = capture.onStop()
  await entered.promise
  await life.remove(start!.audioId)
  assert.equal(request!.signal!.aborted, true)
  result.resolve({ success: true, text: 'stale result' })
  assert.equal((await stopping)?.success, false)
  assert.equal(await HistoryRepo.byId(start!.audioId), null)
  assert.deepEqual(injected, [])
  assert.deepEqual(await readdir(audio), [])
  capture.dispose()
})
await test('audio deletion cancels retry even when renderer uses a separate abort ID', async (_dir, audio) => {
  const entered = deferred(), result = deferred<TranscribeResult>()
  let request: TranscribeParams | undefined
  const capture = new CaptureSession({
    provider: { name: 'delayed-test', transcribe: async p => { request = p; entered.resolve(); return result.promise } },
    getConfig: () => ({ mode: 'voice_transcript', outputLanguage: 'zh', asrLanguage: 'zh', autoInject: false, blacklistDomains: [], appVersion: 'test' }),
    context: () => ({ appName: 'Test', bundleId: 'test', audioContext: {}, selectedText: '' }),
    notify: () => {}, flush: async () => {}, saveAudio: async () => '',
    saveHistory: row => HistoryRepo.upsert(row), loadHistory: id => HistoryRepo.byId(id),
    inject: async () => {}, showCard: () => {}, changed: () => {}, personalization: async () => ({}),
  })
  const life = new HistoryLifecycle(audio, id => capture.cancelByAbortId(id), () => {})
  await put('retry')
  const retry = capture.voiceFlowForRenderer({ audioId: 'retry', abortId: 'other-request-id', arrayBuffer: new Uint8Array([1, 2]), isRetry: true })
  await entered.promise
  await life.remove('retry')
  assert.equal(request!.signal!.aborted, true)
  result.resolve({ success: true, text: 'late' })
  assert.equal((await retry).aborted, true)
  capture.dispose()
})
console.log(`history lifecycle: ${passed} scenarios passed`)
