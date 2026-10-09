// Real isolated server + Electron SQLite client. No user accounts or microphone.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { request } from 'undici'
import { closeDatabase, initDatabase, HistoryRepo } from '../src/main/db'
import { HistoryLifecycle } from '../src/main/services/history-lifecycle'
import { SyncEngine } from '../src/main/services/sync'

const baseUrl = process.env.CLOUD_DELETE_TEST_URL!, root = process.env.CLOUD_DELETE_TEST_DIR!
assert(new URL(baseUrl).hostname === '127.0.0.1' && root.includes('opentype-cloud-delete-'))
let passed = 0
const ok = (name: string) => { passed++; console.log('OK ' + name) }
async function api(path: string, body: unknown = {}, token?: string) {
  const res = await request(baseUrl + '/transcription_history/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return await res.body.json() as any
}
async function account(name: string) {
  const res = await request(baseUrl + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${name}@isolated.invalid`, password: 'synthetic-test-password' }) })
  const data = await res.body.json() as any
  assert.equal(data.status, 'OK')
  return { userId: data.data.user_id as string, token: data.data.access_token as string, serverUrl: baseUrl }
}
const a = await account('lifecycle-a'), b = await account('lifecycle-b'), timer = await account('lifecycle-timer')
const serverDb = new Database(join(root, 'server.db'))
const wire = (id: string) => ({ id, status: 'completed', refined_text: 'Synthetic cloud lifecycle text' })
const row = (id: string) => ({ id, status: 'completed' as const, refinedText: 'Synthetic cloud lifecycle text', createdAt: new Date().toISOString() })
let engine: SyncEngine | undefined, life: HistoryLifecycle, device = '', active = a
function openDevice(name: string) {
  engine?.dispose(); closeDatabase(); device = name
  initDatabase(join(root, name, 'db'))
  life = new HistoryLifecycle(join(root, name, 'audio'), () => {}, () => {})
  const scope = (userId: string) => ({ userId, serverUrl: baseUrl })
  engine = new SyncEngine({ baseUrl, appVersion: 'test', getUserId: () => active.userId, getToken: async () => active.token,
    loadPendingRecords: (id, n, retry) => HistoryRepo.pendingSyncForApi(id, n, retry, [], baseUrl),
    markSynced: ids => HistoryRepo.markSynced(ids), markFailed: ids => HistoryRepo.markSyncFailed(ids),
    applyRemote: async (records, id) => { await HistoryRepo.applyRemote(records as any, scope(id)) },
    applyRemoteDeletions: (ids, id) => life.applyRemoteDeletions(ids, scope(id)),
    loadPendingDeletions: (id, n, retry) => HistoryRepo.pendingCloudDeletions(scope(id), n, retry),
    markDeletions: (id, ids, ack) => HistoryRepo.markCloudDeletions(scope(id), ids, ack),
    loadCursor: id => HistoryRepo.syncCursor(scope(id)), saveCursor: (id, c) => HistoryRepo.saveSyncCursor(scope(id), c),
    applyCloudEpoch: (id, epoch) => HistoryRepo.applyCloudEpoch(scope(id), epoch),
    applyCloudEvictions: (ids, id) => HistoryRepo.applyCloudEvictions(scope(id), ids),
    beginCloudWipe: id => HistoryRepo.beginCloudWipe(scope(id)), finishCloudWipe: (id, requestId) => HistoryRepo.finishCloudWipe(scope(id), requestId),
    hasPendingCloudWipe: id => HistoryRepo.hasPendingCloudWipe(scope(id)), cloudExcludedCount: id => HistoryRepo.cloudExcludedCount(scope(id)),
  })
}
const age = (id: string, days: number, userId = a.userId) => serverDb.prepare('UPDATE history SET cloud_received_at = ? WHERE user_id = ? AND id = ?').run(Date.now() - days * 86400000, userId, id)
const serverHas = (id: string, userId = a.userId) => !!serverDb.prepare('SELECT 1 FROM history WHERE user_id = ? AND id = ?').get(userId, id)
try {
  await api('sync_settings', { cloud_retention: 7 }, timer.token)
  await api('push', { records: [wire('timer-expired')] }, timer.token)
  age('timer-expired', 8, timer.userId)
  const timerStart = Date.now()
  assert(serverHas('timer-expired', timer.userId))

  openDevice('device-a')
  await HistoryRepo.upsert(row('shared'))
  const audio = await life.saveAudio('shared', 'wav', Buffer.from('synthetic audio bytes'))
  assert.equal((await engine!.pushNow()).accepted, 1)
  openDevice('device-b')
  assert.equal((await engine!.pull()).applied, 1)
  await life.saveAudio('shared', 'wav', Buffer.from('second-device audio'))
  await HistoryRepo.upsert(row('offline-unseen'))
  openDevice('device-a')
  assert(await engine!.wipeCloud())
  assert.equal((await api('sync_status', {}, a.token)).data.total, 0)
  assert.equal((await HistoryRepo.byId('shared'))?.refinedText, row('shared').refinedText)
  assert.equal((await readFile(audio!)).toString(), 'synthetic audio bytes')
  assert.equal(HistoryRepo.cloudEpoch(a), 1)
  assert.equal(engine!.localStatus().cloudExcluded, 1)
  assert.equal(engine!.localStatus().pendingCloudWipe, false)
  ok('cloud wipe preserves local text and exact audio bytes; epoch and exclusions persist')

  for (const id of ['shared', 'unknown-old-upload']) {
    assert.equal((await api('push', { records: [wire(id)], cloud_epoch: 0 }, a.token)).detail, 'cloud_epoch_changed')
    assert.equal((await api('push', { records: [wire(id)] }, a.token)).detail, 'cloud_epoch_changed')
  }
  assert.equal((await api('push', { records: [wire('shared')], cloud_epoch: 1 }, a.token)).data.rejected[0].reason, 'cloud_record_evicted')
  ok('stale known and unknown uploads are fenced; current-epoch re-upload cannot revive evicted IDs')

  openDevice('device-b')
  assert.equal((await engine!.pushNow()).accepted, 0)
  assert.equal(HistoryRepo.cloudEpoch(a), 1)
  assert.equal(HistoryRepo.cloudExcludedCount(a), 2)
  assert(await HistoryRepo.byId('offline-unseen'))
  await engine!.pull()
  assert(await HistoryRepo.byId('shared'))
  assert.equal((await readdir(join(root, device, 'audio'))).length, 1)
  await HistoryRepo.upsert(row('after-ack'))
  openDevice('device-b')
  assert.equal(HistoryRepo.cloudEpoch(a), 1)
  assert.equal((await engine!.pushNow()).accepted, 1)
  assert(serverHas('after-ack')); assert(!serverHas('offline-unseen'))
  await HistoryRepo.upsert(row('second-new'))
  await engine!.getStatus()
  assert.equal((await engine!.pushNow()).accepted, 1)
  ok('offline device keeps old captures local; repeated epoch and restart allow new captures to sync')

  assert.equal(await HistoryRepo.applyRemote([{ ...row('shared'), refinedText: 'late downloaded content' }], a), 0)
  assert.equal((await HistoryRepo.byId('shared'))?.refinedText, row('shared').refinedText)
  assert.equal(HistoryRepo.cloudEpoch(b), 0)
  assert.equal(HistoryRepo.cloudExcludedCount(b), 0)
  assert.equal(HistoryRepo.cloudEpoch({ ...a, serverUrl: baseUrl + '/other' }), 0)
  await HistoryRepo.upsert({ ...row('foreign-user'), userId: b.userId, cloudScope: baseUrl })
  await HistoryRepo.upsert({ ...row('foreign-server'), userId: a.userId, cloudScope: baseUrl + '/other' })
  HistoryRepo.applyCloudEpoch(a, 2)
  assert.equal(HistoryRepo.cloudExcludedCount(a), 4)
  assert.equal((await api('push', { records: [wire('shared')] }, b.token)).data.accepted[0], 'shared')
  ok('late cloud content cannot overwrite local copies; account and server namespaces remain independent')

  openDevice('retry-device')
  await engine!.getStatus()
  const requestId = HistoryRepo.beginCloudWipe(a)
  const firstWipe = (await api('wipe', { request_id: requestId }, a.token)).data
  assert.equal(firstWipe.cloud_epoch, 2)
  // Simulate a committed server request whose response never reached the client.
  openDevice('retry-device')
  assert(engine!.localStatus().pendingCloudWipe)
  assert.equal(HistoryRepo.beginCloudWipe(a), requestId)
  await engine!.getStatus()
  await HistoryRepo.upsert(row('survives-retry'))
  assert.equal((await engine!.pushNow()).accepted, 1)
  assert(await engine!.wipeCloud())
  assert(serverHas('survives-retry'))
  assert.equal(HistoryRepo.cloudEpoch(a), 2)
  assert(!HistoryRepo.hasPendingCloudWipe(a))
  assert.deepEqual((await api('wipe', { request_id: requestId }, a.token)).data, firstWipe)
  ok('lost response and database restart replay one persistent request without wiping newer uploads')

  openDevice('device-b')
  await engine!.getStatus()
  const beforeDeletion = HistoryRepo.syncCursor(a)
  assert.equal((await api('delete', { ids: ['shared'] }, a.token)).status, 'OK')
  const changes = (await api('pull', { since: beforeDeletion }, a.token)).data
  assert(changes.deleted.includes('shared')); assert(!changes.evicted.includes('shared'))
  await engine!.pull()
  assert.equal(await HistoryRepo.byId('shared'), null)
  assert.deepEqual(await readdir(join(root, device, 'audio')), [])
  ok('explicit all-device deletion still removes local text and audio after cloud-only eviction')

  await engine!.updateSettings({ sync_enabled: false })
  assert(await engine!.wipeCloud())
  await HistoryRepo.upsert(row('sync-disabled'))
  assert.equal((await engine!.pushNow()).detail, 'sync_disabled')
  assert(!serverHas('sync-disabled'))
  await engine!.updateSettings({ sync_enabled: true })
  assert.equal((await engine!.pushNow()).accepted, 1)
  ok('explicit cloud wipe works while sync is off without enabling automatic upload')

  openDevice('expiry-device')
  await engine!.getStatus()
  await HistoryRepo.upsert(row('expires'))
  const expiresAudio = await life.saveAudio('expires', 'wav', Buffer.from('expiry preserves this'))
  assert.equal((await engine!.pushNow()).accepted, 1)
  age('expires', 8)
  const firstReceipt = (serverDb.prepare('SELECT cloud_received_at AS t FROM history WHERE user_id = ? AND id = ?').get(a.userId, 'expires') as { t: number }).t
  await HistoryRepo.upsert({ id: 'expires', refinedText: 'An edited local transcript', syncStatus: 'pending_upload' })
  assert.equal((await engine!.pushNow()).accepted, 1)
  assert.equal((serverDb.prepare('SELECT cloud_received_at AS t FROM history WHERE user_id = ? AND id = ?').get(a.userId, 'expires') as { t: number }).t, firstReceipt)
  assert.equal((await engine!.updateSettings({ cloud_retention: 7 }))?.total, 1) // sync-disabled was uploaded when re-enabled
  assert(!serverHas('expires'))
  await engine!.pull()
  assert.equal((await HistoryRepo.byId('expires'))?.refinedText, 'An edited local transcript')
  assert.equal((await readFile(expiresAudio!)).toString(), 'expiry preserves this')
  assert.equal((await engine!.pushNow()).accepted, 0)
  ok('retention uses first server receipt despite later edits; expiry preserves local history and audio')

  const epoch = (await api('sync_status', {}, a.token)).data.cloud_epoch
  for (const endpoint of ['pull', 'load_older', 'push', 'sync_status']) {
    const id = 'boundary-' + endpoint
    await api('push', { records: [wire(id)], cloud_epoch: epoch }, a.token); age(id, 8)
    await api(endpoint, endpoint === 'push' ? { records: [], cloud_epoch: epoch } : {}, a.token)
    assert(!serverHas(id))
  }
  assert.equal((await api('push', { records: [wire('boundary-push')], cloud_epoch: epoch }, a.token)).data.rejected[0].reason, 'cloud_record_evicted')
  ok('read, backfill, status and upload boundaries enforce expiry without manual settings changes')

  for (const body of [null, [], 'invalid', 7, { cloud_retention: 0 }, { cloud_retention: '7' }, { cloud_retention: 1 }, { sync_enabled: 1 }]) {
    assert.equal((await api('sync_settings', body, a.token)).detail, 'invalid_sync_settings')
  }
  for (const body of [{}, { request_id: '../bad' }, { request_id: 123 }]) assert.equal((await api('wipe', body, a.token)).detail, 'invalid_wipe_request')
  assert.equal((await api('wipe', { request_id: 'no-auth' })).status, 'ERROR')
  ok('malformed retention/wipe settings and unauthenticated cloud mutations are rejected')

  // Tie three event types at an old timestamp to exercise legacy numeric cursor groups.
  await api('sync_settings', { cloud_retention: -1 }, a.token)
  await api('push', { records: [wire('tie-live')], cloud_epoch: epoch }, a.token)
  await api('delete', { ids: ['tie-delete'] }, a.token)
  serverDb.prepare('INSERT INTO history_cloud_evictions (id,user_id,server_updated_at) VALUES (?,?,?)').run('tie-evict', a.userId, 1)
  serverDb.prepare('UPDATE history SET server_updated_at = 1 WHERE user_id = ? AND id = ?').run(a.userId, 'tie-live')
  serverDb.prepare('UPDATE history_deletions SET server_updated_at = 1 WHERE user_id = ? AND id = ?').run(a.userId, 'tie-delete')
  const seen = new Set<string>(); let cursor = 0, pages = 0
  for (;;) {
    const data = (await api('pull', { since: cursor, limit: 2 }, a.token)).data
    const ids = [...data.records.map((r: any) => r.id), ...data.deleted, ...data.evicted]
    if (!pages) assert.deepEqual(new Set(ids), new Set(['tie-live', 'tie-delete', 'tie-evict']))
    for (const id of ids) { assert(!seen.has(id)); seen.add(id) }
    assert(data.cursor > cursor); cursor = data.cursor; pages++
    if (!data.has_more) break
    assert(pages < 100)
  }
  assert(pages > 1)
  ok('one paginated feed preserves tied live, deletion and cloud-eviction events without gaps')

  // Do not call the timer account API: that would itself trigger boundary cleanup.
  console.log('Waiting for real 60-second server cleanup; observing only isolated SQLite...')
  while (serverHas('timer-expired', timer.userId) && Date.now() - timerStart < 75000) await delay(250)
  assert(!serverHas('timer-expired', timer.userId), 'periodic cleanup did not run')
  assert(serverDb.prepare('SELECT 1 FROM history_cloud_evictions WHERE user_id = ? AND id = ?').get(timer.userId, 'timer-expired'))
  ok('actual periodic server cleanup expires history without any account API traffic')
  console.log(`${passed} real client/server cloud lifecycle scenarios passed`)
} finally { engine?.dispose(); closeDatabase(); serverDb.close() }
