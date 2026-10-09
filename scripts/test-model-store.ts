import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, unlink, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SenseVoiceModelStore } from '../src/main/services/local-asr/model-store'
import { withModelReadiness } from '../src/main/services/local-asr/ready-engine'
import { resolveProfilePaths } from '../src/main/services/profile'

const dir = await mkdtemp(join(tmpdir(), 'opentype-model-lifecycle-'))
const originalFetch = globalThis.fetch
const bytes = [Buffer.from('synthetic model bytes'), Buffer.from('synthetic tokens')]
const files = ['model.int8.onnx', 'tokens.txt'].map((name, i) => ({ name, bytes: bytes[i].length,
  sha256: createHash('sha256').update(bytes[i]).digest('hex') }))
let passed = 0
const test = async (name: string, work: () => Promise<void> | void) => {
  await work(); passed++; console.log(`OK ${name}`)
}
const source = join(dir, 'bundle'), target = join(dir, 'cache')
await mkdir(source)
for (const [i, file] of files.entries()) await writeFile(join(source, file.name), bytes[i])
const model = new SenseVoiceModelStore(target, files)
const noNetwork = async () => { throw new Error('offline') }
globalThis.fetch = noNetwork
try {
  await test('offline first install and concurrent imports share one operation', async () => {
    const a = model.importBundle(source), b = model.importBundle(source)
    assert.equal(a, b)
    assert.notEqual((await model.check()).state, 'ready')
    assert.equal((await a).state, 'ready')
    assert.deepEqual((await readdir(target)).sort(), files.map(f => f.name).sort())
  })
  await test('validated existing model is preserved across installation and fresh store restart', async () => {
    const before = await stat(join(target, files[0].name), { bigint: true })
    assert.equal((await model.install(source)).state, 'ready')
    assert.equal((await new SenseVoiceModelStore(target, files).importBundle(source)).state, 'ready')
    const after = await stat(join(target, files[0].name), { bigint: true })
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs)
  })
  await test('deleted cached-ready file becomes missing; settings action repairs offline', async () => {
    await unlink(join(target, files[1].name))
    assert.equal((await model.check()).state, 'missing')
    assert.equal((await model.install(source)).state, 'ready')
    assert.deepEqual(await readFile(join(target, files[1].name)), bytes[1])
  })
  await test('same-size corruption with restored mtime invalidates checksum cache', async () => {
    await model.check()
    const path = join(target, files[0].name), before = await stat(path)
    await writeFile(path, Buffer.alloc(files[0].bytes, 65)); await utimes(path, before.atime, before.mtime)
    assert.equal((await model.check()).state, 'missing')
    assert.equal((await model.install(source)).state, 'ready')
  })
  await test('check in flight cannot overwrite the later repair result', async () => {
    await writeFile(join(target, files[1].name), Buffer.alloc(files[1].bytes, 66))
    const checking = model.check(), repair = model.importBundle(source)
    await checking
    assert.equal((await repair).state, 'ready')
    assert.equal((await model.check()).state, 'ready')
  })
  await test('invalid bundled file never publishes bad bytes; error persists on polling', async () => {
    const invalid = new SenseVoiceModelStore(join(dir, 'invalid'), files)
    assert.equal((await invalid.importBundle(join(dir, 'no-bundle'))).state, 'error')
    assert.equal((await invalid.check()).state, 'error')
    assert.deepEqual(await readdir(invalid.directory), [])
    assert.equal((await invalid.importBundle(source)).state, 'ready')
    assert.equal((await invalid.check()).error, undefined)
  })
  await test('cancellation settles shared import and next import can retry', async () => {
    const cancelled = new SenseVoiceModelStore(join(dir, 'cancelled'), files)
    const pending = cancelled.importBundle(source); cancelled.dispose()
    assert.match((await pending).error!, /取消/)
    assert.deepEqual(await readdir(cancelled.directory), [])
    assert.equal((await cancelled.importBundle(source)).state, 'ready')
  })
  await test('offline repair never fetches when bundle is valid', async () => {
    globalThis.fetch = async () => { assert.fail('unexpected network request') }
    assert.equal((await new SenseVoiceModelStore(join(dir, 'offline'), files).install(source)).state, 'ready')
  })
  await test('explicit setup downloads only the missing bundle file and validates it', async () => {
    const partial = join(dir, 'partial'); await mkdir(partial)
    await writeFile(join(partial, files[0].name), bytes[0])
    const requests: string[] = []
    globalThis.fetch = async input => { requests.push(String(input)); return new Response(bytes[1]) }
    const downloaded = new SenseVoiceModelStore(join(dir, 'downloaded'), files)
    assert.equal((await downloaded.install(partial)).state, 'ready')
    assert.equal(requests.length, 1); assert.match(requests[0], /tokens\.txt$/)
    assert.equal((await downloaded.check()).state, 'ready')
  })
  await test('same-size corrupt download is rejected and partial file removed', async () => {
    globalThis.fetch = async () => new Response(Buffer.alloc(bytes[0].length))
    const bad = new SenseVoiceModelStore(join(dir, 'bad-download'), files)
    assert.equal((await bad.install()).state, 'error'); assert.deepEqual(await readdir(bad.directory), [])
  })
  await test('download cancellation aborts pending network and allows offline retry', async () => {
    let requested!: () => void
    const started = new Promise<void>(resolve => { requested = resolve })
    globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); requested()
    })
    const cancelled = new SenseVoiceModelStore(join(dir, 'cancel-download'), files)
    const pending = cancelled.install(); await started; cancelled.dispose()
    assert.match((await pending).error!, /取消/)
    assert.deepEqual(await readdir(cancelled.directory), [])
    assert.equal((await cancelled.install(source)).state, 'ready')
  })
  await test('symlink in cache is replaced without changing its target', async () => {
    const path = join(target, files[1].name)
    await unlink(path); await symlink(join(source, files[1].name), path)
    assert.equal((await model.check()).state, 'missing')
    assert.equal((await model.importBundle(source)).state, 'ready')
    assert.deepEqual(await readFile(join(source, files[1].name)), bytes[1])
  })
  await test('recordings and pause segments cannot reach ASR with unready files; repair needs no restart', async () => {
    let calls = 0
    const engine = withModelReadiness({ transcribe: async () => { calls++; return { text: 'recognized' } } }, model)
    assert.equal((await engine.transcribe(new Uint8Array())).text, 'recognized')
    await unlink(join(target, files[1].name))
    assert.equal((await engine.transcribe(new Uint8Array())).error, 'model_not_ready'); assert.equal(calls, 1)
    const pending = model.importBundle(source)
    assert.equal((await engine.transcribe(new Uint8Array())).error, 'model_not_ready')
    await pending
    assert.equal((await engine.transcribe(new Uint8Array())).text, 'recognized'); assert.equal(calls, 2)
    assert.equal((await engine.transcribe(new Uint8Array(), AbortSignal.abort())).error, 'cancelled'); assert.equal(calls, 2)
  })
  await test('default packaged profile stays fixed and ignores development override', () => {
    assert.deepEqual(resolveProfilePaths({appData:'/support',defaultLogs:'/logs',packaged:true,testDirectory:'/test'}),
      {userData:'/support/dev.opentype.desktop',logs:'/logs',custom:false})
  })
  await test('explicit absolute profile isolates logs; development override remains supported', () => {
    const base = {appData:'/support',defaultLogs:'/logs',packaged:true}
    assert.deepEqual(resolveProfilePaths({...base,cliDirectory:'/tmp/independent/../profile'}),
      {userData:'/tmp/profile',logs:'/tmp/profile/logs',custom:true})
    assert.equal(resolveProfilePaths({...base,packaged:false,testDirectory:'/test'}).userData, '/test')
  })
  await test('empty, relative and root profile requests are rejected', () => {
    for (const cliDirectory of ['', 'relative', '/', '/tmp/..']) {
      assert.throws(() => resolveProfilePaths({appData:'/support',defaultLogs:'/logs',packaged:true,cliDirectory}), /absolute non-root/)
    }
  })
  console.log(`PASS ${passed} model lifecycle and profile scenarios`)
} finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }) }
