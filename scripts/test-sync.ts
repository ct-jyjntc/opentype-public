// Exercise the actual engine, SQLite repository and HTTP boundary together.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initDatabase, closeDatabase, HistoryRepo } from '../src/main/db'
import { SyncEngine, type SyncEngineOptions } from '../src/main/services/sync'

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3000
  while (!(await check())) {
    assert(Date.now() < end, 'condition timed out')
    await delay(5)
  }
}

async function fixture(overrides: Partial<SyncEngineOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opentype-sync-test-'))
  initDatabase(dir)
  const state = {
    enabled: true, failPush: 0, failStatus: false, failSettings: false,
    userId: 'user-a', reads: 0, requests: [] as string[], batches: [] as string[][],
    blocked: {} as Record<string, boolean>, phases: [] as string[],
    holdPush: null as null | Promise<void>, holdDelete: null as null | Promise<void>,
    failDelete: 0, deletionVersion: 1, partialDelete: false, deletions: [] as string[][],
    lifecycleVersion: 1, epoch: 0, failWipe: false, holdWipe: null as null | Promise<void>,
    wipes: [] as string[], wipeResults: new Map<string, number>(),
    pull: { records: [] as any[], deleted: [] as string[], evicted: [] as string[], cursor: 0, has_more: false },
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    state.requests.push(req.url!)
    let data: unknown = {}
    let detail: string | undefined
    if (req.url?.endsWith('/sync_status')) {
      if (state.failStatus) detail = 'status_unavailable'
      data = { sync_enabled: state.enabled, total: 0, history_deletion_version: state.deletionVersion, cloud_lifecycle_version: state.lifecycleVersion, cloud_epoch: state.epoch }
    } else if (req.url?.endsWith('/sync_settings')) {
      if (state.failSettings) detail = 'settings_unavailable'
      else if (body.sync_enabled !== undefined) state.enabled = body.sync_enabled
      data = { sync_enabled: state.enabled, total: 0 }
    } else if (req.url?.endsWith('/wipe')) {
      state.wipes.push(body.request_id)
      if (!state.wipeResults.has(body.request_id)) state.wipeResults.set(body.request_id, ++state.epoch)
      if (state.holdWipe) await state.holdWipe
      if (state.failWipe) detail = 'wipe_response_lost'
      data = { deleted: 1, cloud_epoch: state.wipeResults.get(body.request_id) }
    } else if (req.url?.endsWith('/push')) {
      state.batches.push(body.records.map((r: any) => r.id))
      if (state.holdPush) await state.holdPush
      if (state.failPush > 0) { state.failPush--; detail = 'temporary_failure' }
      else data = { accepted: body.records.map((r: any) => r.id), rejected: [] }
    } else if (req.url?.endsWith('/delete')) {
      state.deletions.push(body.ids)
      if (state.holdDelete) await state.holdDelete
      if (state.failDelete > 0) { state.failDelete--; detail = 'delete_unavailable' }
      else data = { accepted: state.partialDelete ? body.ids.slice(0, 1) : body.ids }
    } else if (req.url?.endsWith('/pull')) {
      data = { ...state.pull, cursor: Math.max(body.since, state.pull.cursor) }
    }
    res.writeHead(detail ? 503 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(detail ? { status: 'ERROR', detail } : { status: 'OK', data }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const scoped = (userId: string) => ({ userId, serverUrl: `http://127.0.0.1:${port}` })
  const options: SyncEngineOptions = {
    baseUrl: `http://127.0.0.1:${port}`, appVersion: 'test',
    getUserId: () => state.userId, getToken: async () => 'synthetic-token',
    loadSyncBlocked: id => state.blocked[id] === true,
    saveSyncBlocked: (id, value) => { state.blocked[id] = value },
    loadPendingRecords: async (id, limit, includeExhausted) => {
      state.reads++
      return HistoryRepo.pendingSyncForApi(id, limit, includeExhausted, [], scoped(id).serverUrl)
    },
    markSynced: ids => HistoryRepo.markSynced(ids), markFailed: ids => HistoryRepo.markSyncFailed(ids),
    applyRemote: async records => { await HistoryRepo.applyRemote(records as any) },
    loadPendingDeletions: (id, limit, retry) => HistoryRepo.pendingCloudDeletions(scoped(id), limit, retry),
    markDeletions: (id, ids, ack) => HistoryRepo.markCloudDeletions(scoped(id), ids, ack),
    applyRemoteDeletions: async (ids, id) => { await HistoryRepo.applyRemoteDeletions(ids, scoped(id)) },
    loadCursor: id => HistoryRepo.syncCursor(scoped(id)),
    saveCursor: (id, cursor) => HistoryRepo.saveSyncCursor(scoped(id), cursor),
    applyCloudEpoch: (id, epoch) => HistoryRepo.applyCloudEpoch(scoped(id), epoch),
    applyCloudEvictions: (ids, id) => HistoryRepo.applyCloudEvictions(scoped(id), ids),
    beginCloudWipe: id => HistoryRepo.beginCloudWipe(scoped(id)),
    finishCloudWipe: (id, requestId) => HistoryRepo.finishCloudWipe(scoped(id), requestId),
    hasPendingCloudWipe: id => HistoryRepo.hasPendingCloudWipe(scoped(id)),
    cloudExcludedCount: id => HistoryRepo.cloudExcludedCount(scoped(id)),
    onStateChange: s => state.phases.push(s.phase),
    pushDebounceMs: 5, retryDelayMs: 5, requestTimeoutMs: 500,
    ...overrides
  }
  const engine = new SyncEngine(options)
  const add = async (count = 1) => {
    for (let i = 0; i < count; i++) await HistoryRepo.upsert({
      id: `record-${i}`, userId: 'user-a', status: 'completed', mode: 'voice_transcript',
      refinedText: `Synthetic test ${i}`, createdAt: new Date().toISOString()
    })
  }
  return {
    state, engine, options, add, scoped, dir,
    close: async () => {
      engine.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      closeDatabase()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

let passed = 0
async function test(name: string, fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  try { await fn(f); passed++; console.log(`OK ${name}`) }
  finally { await f.close() }
}

await test('disabled sync never reads or uploads history', async f => {
  await f.add()
  f.state.enabled = false
  await f.engine.pushNow({ retryFailed: true })
  assert.equal(f.state.reads, 0)
  assert.deepEqual(f.state.batches, [])
  assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'pending_upload')
})

await test('sync excludes raw AX/debug data and redacts sensitive context', async () => {
  await HistoryRepo.upsert({
    id: 'privacy', userId: 'user-a', status: 'completed', mode: 'voice_command', refinedText: 'Synthetic output',
    focusedAppBundleId: 'com.apple.Terminal', axText: 'AX-SECRET', axHtml: 'HTML-SECRET',
    debugInfo: 'DEBUG-SECRET', clientMetadata: 'CLIENT-SECRET', inputContext: 'INPUT-SECRET',
    audioLocalPath: '/synthetic/private/path.wav',
    modeMeta: JSON.stringify({ selected_text: 'SELECTED-SECRET' }),
    audioContext: JSON.stringify({ input_context: 'CONTEXT-SECRET' })
  })
  const records = await HistoryRepo.pendingSyncForApi('user-a')
  const json = JSON.stringify(records)
  assert(!json.includes('SECRET'))
  assert(!json.includes('/synthetic/private'))
  assert.equal(records[0].refined_text, 'Synthetic output')
  assert.equal(JSON.parse(records[0].audio_context as string).redacted, true)
})

await test('unavailable permission/status fails closed', async f => {
  await f.add()
  f.state.failStatus = true
  await f.engine.pushNow()
  assert.equal(f.state.reads, 0)
  assert.equal(f.state.batches.length, 0)
})

await test('450 pending records drain in three batches', async f => {
  await f.add(450)
  assert.deepEqual(await f.engine.pushNow(), { pushed: 450, accepted: 450 })
  assert.deepEqual(f.state.batches.map(b => b.length), [200, 200, 50])
  assert.equal((await HistoryRepo.pendingSync('user-a')).length, 0)
  assert.equal(f.state.phases.at(-1), 'idle')
})

await test('transient server failure automatically recovers from SQLite failed state', async f => {
  await f.add()
  f.state.failPush = 1
  await f.engine.pushNow()
  assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'sync_failed')
  await until(async () => (await HistoryRepo.byId('record-0'))?.syncStatus === 'synced')
  assert.equal(f.state.batches.length, 2)
})

await test('automatic retries stop at three; explicit manual retry can recover', async f => {
  await f.add()
  f.state.failPush = 100
  await f.engine.pushNow()
  await until(async () => (await HistoryRepo.byId('record-0'))?.syncAttemptCount === 3)
  await delay(40)
  assert.equal(f.state.batches.length, 3)
  assert.equal((await HistoryRepo.pendingSync('user-a')).length, 0)
  f.state.failPush = 0
  assert.equal((await f.engine.pushNow({ retryFailed: true })).accepted, 1)
  assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'synced')
})

await test('offline disable persists across engine restart and requires successful re-enable', async f => {
  await f.add()
  f.state.failSettings = true
  assert.equal(await f.engine.updateSettings({ sync_enabled: false }), null)
  assert.equal(f.state.blocked['user-a'], true)
  f.engine.dispose()
  const restarted = new SyncEngine(f.options)
  try {
    await restarted.pushNow()
    assert.equal(f.state.batches.length, 0)
    assert.equal((await restarted.getStatus())?.sync_enabled, false)
    assert.equal(await restarted.updateSettings({ sync_enabled: true }), null)
    await restarted.pushNow()
    assert.equal(f.state.batches.length, 0)
    f.state.failSettings = false
    assert.equal((await restarted.updateSettings({ sync_enabled: true }))?.sync_enabled, true)
    await until(() => f.state.batches.length === 1)
  } finally { restarted.dispose() }
})

await test('disable aborts an in-flight upload and ignores its late acknowledgement', async f => {
  await f.add()
  let release!: () => void
  f.state.holdPush = new Promise<void>(resolve => { release = resolve })
  const pending = f.engine.pushNow()
  await until(() => f.state.batches.length === 1)
  await f.engine.updateSettings({ sync_enabled: false })
  await pending
  release()
  await delay(10)
  assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'pending_upload')
  assert.equal((await HistoryRepo.byId('record-0'))?.syncAttemptCount, 0)
})

await test('account switch during token refresh cannot upload old records with a new token', async f => {
  await f.add()
  f.engine.dispose()
  let release!: (token: string) => void
  let tokens = 0
  const engine = new SyncEngine({ ...f.options, getToken: async () => {
    tokens++
    return tokens === 1 ? 'account-a' : new Promise<string>(r => { release = r })
  } })
  try {
    const pending = engine.pushNow()
    await until(() => tokens === 2)
    f.state.userId = 'user-b'
    engine.invalidateSession()
    release('account-b')
    await pending
    assert.equal(f.state.batches.length, 0)
    assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'pending_upload')
  } finally { engine.dispose() }
})

await test('empty queue emits complete UI lifecycle', async f => {
  await f.engine.pushNow()
  assert.deepEqual(f.state.phases, ['pushing', 'idle'])
})

async function queueDeletion(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  await f.add(count)
  await HistoryRepo.pendingSyncForApi('user-a', count, false, [], f.options.baseUrl)
  for (let i = 0; i < count; i++) await HistoryRepo.remove(`record-${i}`, f.scoped('user-a'))
}

await test('failed cloud deletions stop after three attempts and survive restart for manual retry', async f => {
  await queueDeletion(f)
  f.state.failDelete = 100
  await f.engine.pushNow()
  await until(() => f.state.deletions.length === 3)
  await delay(40)
  assert.equal(f.state.deletions.length, 3)
  assert.deepEqual(HistoryRepo.pendingCloudDeletions(f.scoped('user-a')), [])
  assert.equal(HistoryRepo.cloudDeletionCount(f.scoped('user-a')), 1)
  f.engine.dispose(); closeDatabase(); initDatabase(f.dir)
  const restarted = new SyncEngine(f.options)
  try {
    await restarted.pushNow()
    assert.equal(f.state.deletions.length, 3)
    f.state.failDelete = 0
    await restarted.pushNow({ retryFailed: true })
    assert.equal(HistoryRepo.cloudDeletionCount(f.scoped('user-a')), 0)
  } finally { restarted.dispose() }
})

await test('partial deletion acknowledgement retries only unconfirmed IDs', async f => {
  await queueDeletion(f, 2)
  f.state.partialDelete = true
  await f.engine.pushNow()
  await until(() => HistoryRepo.cloudDeletionCount(f.scoped('user-a')) === 0)
  assert.deepEqual(f.state.deletions, [['record-0', 'record-1'], ['record-1']])
})

await test('delete during in-flight upload drains the deletion immediately after the upload', async f => {
  await f.add()
  let release!: () => void
  f.state.holdPush = new Promise<void>(r => { release = r })
  const pushing = f.engine.pushNow()
  await until(() => f.state.batches.length === 1)
  await HistoryRepo.remove('record-0', f.scoped('user-a'))
  release(); await pushing
  assert.deepEqual(f.state.deletions, [['record-0']])
  assert.equal(await HistoryRepo.byId('record-0'), null)
  assert.equal(HistoryRepo.cloudDeletionCount(f.scoped('user-a')), 0)
})

await test('account switch rejects a late deletion acknowledgement and never sends it as another account', async f => {
  await queueDeletion(f)
  let release!: () => void
  f.state.holdDelete = new Promise<void>(r => { release = r })
  const pushing = f.engine.pushNow()
  await until(() => f.state.deletions.length === 1)
  f.state.userId = 'user-b'; f.engine.invalidateSession()
  await pushing; release()
  await f.engine.pushNow()
  assert.equal(f.state.deletions.length, 1)
  assert.equal(HistoryRepo.cloudDeletionCount(f.scoped('user-a')), 1)
})

await test('older servers leave deletion intent pending and report unsupported capability', async f => {
  await queueDeletion(f)
  f.state.deletionVersion = 0
  const result = await f.engine.pushNow()
  assert.equal(result.detail, 'cloud_deletion_unsupported')
  assert.equal(f.state.deletions.length, 0)
  assert.equal(HistoryRepo.cloudDeletionCount(f.scoped('user-a')), 1)
})

await test('failed deletion application never advances the durable pull cursor', async f => {
  f.engine.dispose()
  f.state.pull = { records: [], deleted: ['gone'], evicted: [], cursor: 10, has_more: false }
  let fail = true
  const reader = new SyncEngine({ ...f.options, applyRemoteDeletions: async (ids, id) => {
    if (fail) throw new Error('database_unavailable')
    await f.options.applyRemoteDeletions!(ids, id)
  } })
  try {
    assert.equal((await reader.pull()).cursor, 0)
    assert.equal(HistoryRepo.syncCursor(f.scoped('user-a')), 0)
    fail = false
    assert.equal((await reader.pull()).cursor, 10)
    assert.equal(HistoryRepo.syncCursor(f.scoped('user-a')), 10)
    assert.equal(HistoryRepo.syncCursor(f.scoped('user-b')), 0)
  } finally { reader.dispose() }
})

await test('public HTTP fails before reading a token or sending any request', async f => {
  let reads = 0
  const insecure = new SyncEngine({ ...f.options, baseUrl: 'http://192.0.2.1:9100', getToken: async () => { reads++; return 'synthetic' } })
  try {
    assert.equal((await insecure.pushNow()).detail, 'insecure_cloud_url')
    assert.equal(reads, 0)
    assert.deepEqual(f.state.requests, [])
  } finally { insecure.dispose() }
})

await test('invalid saved cloud URLs fail locally without requesting credentials', async f => {
  let reads = 0
  for (const baseUrl of ['not-a-url', 'https://example.invalid/api?secret=x', 'https://user:pass@example.invalid']) {
    const invalid = new SyncEngine({ ...f.options, baseUrl, getToken: async () => { reads++; return 'synthetic' } })
    try { assert.equal((await invalid.pushNow()).detail, 'invalid_cloud_url') }
    finally { invalid.dispose() }
  }
  assert.equal(reads, 0)
})

await test('cloud wipe aborts in-flight uploads and excludes their late acknowledgements', async f => {
  await f.add()
  let release!: () => void
  f.state.holdPush = new Promise<void>(r => { release = r })
  const push = f.engine.pushNow()
  await until(() => f.state.batches.length === 1)
  assert(await f.engine.wipeCloud())
  release(); await push
  assert.equal((await HistoryRepo.byId('record-0'))?.syncStatus, 'pending_upload')
  assert.equal(HistoryRepo.cloudExcludedCount(f.scoped('user-a')), 1)
  assert.equal((await f.engine.pushNow()).accepted, 0)
})

await test('duplicate wipe, push and pull wait for the active wipe response', async f => {
  let release!: () => void
  f.state.holdWipe = new Promise<void>(r => { release = r })
  const wipe = f.engine.wipeCloud()
  await until(() => f.state.wipes.length === 1)
  assert.equal(await f.engine.wipeCloud(), false)
  await f.engine.pushNow(); await f.engine.pull()
  assert(!f.state.requests.includes('/transcription_history/push'))
  assert(!f.state.requests.includes('/transcription_history/pull'))
  release(); assert(await wipe)
  assert.equal(f.state.wipes.length, 1)
})

await test('account switch rejects a late wipe result and preserves its original pending request', async f => {
  let release!: () => void
  f.state.holdWipe = new Promise<void>(r => { release = r })
  const wipe = f.engine.wipeCloud()
  await until(() => f.state.wipes.length === 1)
  f.state.userId = 'user-b'; f.engine.invalidateSession()
  release(); assert.equal(await wipe, false)
  assert(HistoryRepo.hasPendingCloudWipe(f.scoped('user-a')))
  assert(!HistoryRepo.hasPendingCloudWipe(f.scoped('user-b')))
  assert.equal(HistoryRepo.cloudEpoch(f.scoped('user-a')), 0)
  assert.equal(HistoryRepo.cloudEpoch(f.scoped('user-b')), 0)
})

await test('uncertain wipe retries one request after engine restart and preserves newer records', async f => {
  await f.add(); f.state.failWipe = true
  assert.equal(await f.engine.wipeCloud(), false)
  const id = f.state.wipes[0]
  assert(HistoryRepo.hasPendingCloudWipe(f.scoped('user-a')))
  f.engine.dispose(); f.state.failWipe = false
  const next = new SyncEngine(f.options)
  try {
    await next.getStatus()
    await HistoryRepo.upsert({ id: 'new-after-ack', status: 'completed', refinedText: 'new content' })
    assert(await next.wipeCloud())
    assert.deepEqual(f.state.wipes, [id, id])
    assert.equal(f.state.epoch, 1)
    assert.equal((await next.pushNow()).accepted, 1)
    assert(!HistoryRepo.hasPendingCloudWipe(f.scoped('user-a')))
  } finally { next.dispose() }
})

await test('unsupported cloud lifecycle or missing persistence prevents destructive requests', async f => {
  f.state.lifecycleVersion = 0
  assert.equal(await f.engine.wipeCloud(), false)
  assert.equal(await f.engine.updateSettings({ cloud_retention: 7 }), null)
  assert.deepEqual(f.state.wipes, [])
  assert(!f.state.requests.includes('/transcription_history/sync_settings'))
  f.state.lifecycleVersion = 1
  const incomplete = new SyncEngine({ ...f.options, beginCloudWipe: undefined })
  try { assert.equal(await incomplete.wipeCloud(), false); assert.deepEqual(f.state.wipes, []) }
  finally { incomplete.dispose() }
})

await test('invalid cloud epoch prevents upload and cannot overwrite durable state', async f => {
  await f.add()
  for (const epoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.state.epoch = epoch
    assert.equal((await f.engine.pushNow()).detail, 'invalid_cloud_epoch')
    assert.equal(HistoryRepo.cloudEpoch(f.scoped('user-a')), 0)
  }
  assert.deepEqual(f.state.batches, [])
})

await test('failed cloud eviction application preserves local records and pull cursor for retry', async f => {
  await f.add()
  f.state.pull = { records: [], deleted: [], evicted: ['record-0'], cursor: 10, has_more: false }
  const reader = new SyncEngine({ ...f.options, applyCloudEvictions: () => { throw new Error('storage_unavailable') } })
  try {
    assert.equal((await reader.pull()).detail, 'storage_unavailable')
    assert.equal(HistoryRepo.syncCursor(f.scoped('user-a')), 0)
    assert(await HistoryRepo.byId('record-0'))
  } finally { reader.dispose() }
  assert.equal((await f.engine.pull()).cursor, 10)
  assert.equal(HistoryRepo.cloudExcludedCount(f.scoped('user-a')), 1)
  assert(await HistoryRepo.byId('record-0'))
})

console.log(`${passed} integration scenarios passed`)
