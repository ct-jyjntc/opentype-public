import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { request } from 'undici'
import { closeDatabase, initDatabase, HistoryRepo } from '../src/main/db'
import { HistoryLifecycle } from '../src/main/services/history-lifecycle'
import { SyncEngine } from '../src/main/services/sync'

const baseUrl = process.env.CLOUD_DELETE_TEST_URL!
const root = process.env.CLOUD_DELETE_TEST_DIR!
assert(new URL(baseUrl).hostname === '127.0.0.1' && root.includes('opentype-cloud-delete-'))
let passed = 0
const ok = (name: string) => { passed++; console.log('OK ' + name) }
async function api(path: string, body: unknown = {}, token?: string) {
  const res = await request(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const data = await res.body.json() as any
  return data
}
async function account(name: string) {
  const data = await api('/oauth/register', { email: `${name}@isolated.invalid`, password: 'synthetic-test-password' })
  assert.equal(data.status, 'OK')
  return { userId: data.data.user_id as string, token: data.data.access_token as string, serverUrl: baseUrl }
}
const a = await account('delete-a'), b = await account('delete-b')
let active = a
let engine: SyncEngine | undefined
let life: HistoryLifecycle
let device = ''
const cancelled: string[] = []
function openDevice(name: string) {
  engine?.dispose(); closeDatabase(); device = name
  initDatabase(join(root, name, 'db'))
  life = new HistoryLifecycle(join(root, name, 'audio'), id => cancelled.push(id), () => {})
  const scoped = (userId: string) => ({ userId, serverUrl: baseUrl })
  engine = new SyncEngine({ baseUrl, appVersion: 'test', getUserId: () => active.userId, getToken: async () => active.token,
    loadPendingRecords: (id, limit, retry) => HistoryRepo.pendingSyncForApi(id, limit, retry, [], baseUrl),
    markSynced: ids => HistoryRepo.markSynced(ids), markFailed: ids => HistoryRepo.markSyncFailed(ids),
    loadPendingDeletions: (id, limit, retry) => HistoryRepo.pendingCloudDeletions(scoped(id), limit, retry),
    markDeletions: (id, ids, ack) => HistoryRepo.markCloudDeletions(scoped(id), ids, ack),
    countPendingDeletions: id => HistoryRepo.cloudDeletionCount(scoped(id)),
    applyRemote: async (records, id) => { await HistoryRepo.applyRemote(records as any, scoped(id)) },
    applyRemoteDeletions: (ids, id) => life.applyRemoteDeletions(ids, scoped(id)),
    loadCursor: id => HistoryRepo.syncCursor(scoped(id)), saveCursor: (id, c) => HistoryRepo.saveSyncCursor(scoped(id), c),
    applyCloudEpoch:(id,epoch)=>HistoryRepo.applyCloudEpoch(scoped(id),epoch),
    applyCloudEvictions:(ids,id)=>HistoryRepo.applyCloudEvictions(scoped(id),ids),
    beginCloudWipe:id=>HistoryRepo.beginCloudWipe(scoped(id)),finishCloudWipe:(id,request)=>HistoryRepo.finishCloudWipe(scoped(id),request),
    hasPendingCloudWipe:id=>HistoryRepo.hasPendingCloudWipe(scoped(id)),cloudExcludedCount:id=>HistoryRepo.cloudExcludedCount(scoped(id)),
    onStateChange: state => { if (state.phase === 'error') console.log('Test sync error: ' + state.detail) },
  })
}
const row = (id: string) => ({ id, status: 'completed' as const, refinedText: 'Synthetic deletion test', createdAt: new Date().toISOString() })
const wire = (id: string) => ({ id, status: 'completed', refined_text: 'Synthetic deletion test' })
try {
  openDevice('device-a')
  await HistoryRepo.upsert(row('shared'))
  assert.equal((await engine!.pushNow()).accepted, 1)
  assert.equal((await HistoryRepo.byId('shared'))?.userId, a.userId)
  assert.equal((await HistoryRepo.byId('shared'))?.cloudScope, baseUrl)
  await engine!.pull()
  assert(HistoryRepo.syncCursor(a) > 0)
  ok('upload claims anonymous history and saves an account-scoped local cursor')

  openDevice('device-b')
  assert.equal((await engine!.pull()).applied, 1)
  await life.saveAudio('shared', 'wav', Buffer.from('synthetic audio'))
  const cursorBeforeDelete = HistoryRepo.syncCursor(a)
  assert(cursorBeforeDelete > 0)
  ok('second device downloads initial content from its own cursor')

  openDevice('device-a')
  await life.remove('shared', a)
  assert.deepEqual(HistoryRepo.pendingCloudDeletions(a), ['shared'])
  assert.equal(await HistoryRepo.byId('shared'), null)
  openDevice('device-a')
  assert.equal(engine!.localStatus().pendingDeletions, 1)
  assert.equal((await api('/transcription_history/sync_status', {}, a.token)).data.total, 1)
  ok('offline deletion removes local text and persists intent across database restart')

  active = b; engine!.invalidateSession()
  await engine!.pushNow()
  assert.equal(HistoryRepo.cloudDeletionCount(a), 1)
  assert.equal(engine!.localStatus().pendingDeletions, 0)
  assert.deepEqual(HistoryRepo.pendingCloudDeletions({ ...a, serverUrl: baseUrl + '/other' }), [])
  active = a; engine!.invalidateSession()
  await engine!.pushNow()
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  assert.equal((await api('/transcription_history/sync_status', {}, a.token)).data.total, 0)
  ok('queued deletion stays isolated across account and server changes, then resumes for its owner')

  const first = (await api('/transcription_history/pull', { since: cursorBeforeDelete }, a.token)).data
  assert.deepEqual(first.deleted, ['shared'])
  assert(first.cursor > cursorBeforeDelete)
  const repeat = await api('/transcription_history/delete', { ids: ['shared', 'shared'] }, a.token)
  assert.equal(repeat.data.server_updated_at, first.cursor)
  ok('idempotent deletion-only feed advances beyond the last content cursor')

  openDevice('device-b')
  await HistoryRepo.upsert({ id: 'shared', refinedText: 'Stale offline edit', syncStatus: 'pending_upload' })
  await engine!.pull()
  assert.equal(await HistoryRepo.byId('shared'), null)
  assert.deepEqual(await readdir(join(root, device, 'audio')), [])
  assert(cancelled.includes('shared'))
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  assert.equal(HistoryRepo.syncCursor(a), first.cursor)
  assert.equal((await HistoryRepo.applyRemote([row('shared')], a)), 0)
  ok('remote deletion wins over unsent edits, cancels work, removes audio and does not echo an upload')

  openDevice('stale-device')
  await HistoryRepo.upsert({ ...row('shared'), userId: a.userId, cloudScope: baseUrl })
  await life.saveAudio('shared', 'wav', Buffer.from('stale synthetic audio'))
  const stale = await engine!.pushNow()
  assert.equal(stale.detail, undefined)
  assert.equal(stale.accepted, 0)
  assert.equal(await HistoryRepo.byId('shared'), null)
  assert.deepEqual(await readdir(join(root, device, 'audio')), [])
  ok('server rejects a late stale upload and the client consumes the deletion immediately')

  const foreign = await api('/transcription_history/push', { records: [wire('shared')] }, b.token)
  assert.deepEqual(foreign.data.accepted, ['shared'])
  assert.equal((await api('/transcription_history/sync_status', {}, b.token)).data.total, 1)
  assert(!(await api('/transcription_history/load_older', { before: null }, a.token)).data.records.some((r: any) => r.id === 'shared'))
  await HistoryRepo.upsert({ ...row('foreign'), userId: b.userId, cloudScope: baseUrl })
  await assert.rejects(life.remove('foreign', a), /history_cloud_account_mismatch/)
  await life.applyRemoteDeletions(['foreign'], a)
  assert.equal((await HistoryRepo.byId('foreign'))?.userId, b.userId)
  ok('same record ID is independent on the server; remote/local deletion cannot erase another account locally')

  await api('/transcription_history/delete', { ids: ['before-upload'] }, a.token)
  assert.equal((await api('/transcription_history/push', { records: [wire('before-upload')] }, a.token)).data.rejected[0].reason, 'record_deleted')
  for (const ids of [[], ['../outside'], [''], Array(201).fill('too-many'), [12]]) {
    assert.equal((await api('/transcription_history/delete', { ids }, a.token)).status, 'ERROR')
  }
  assert.equal((await api('/transcription_history/delete', { ids: ['shared'] })).status, 'ERROR')
  ok('delete-before-upload is permanent; invalid batches and unauthenticated requests are rejected')

  openDevice('bulk-device')
  for (let i = 0; i < 215; i++) await HistoryRepo.upsert(row(`bulk-${String(i).padStart(3, '0')}`))
  assert.equal((await engine!.pushNow()).accepted, 215)
  for (let i = 0; i < 215; i++) await HistoryRepo.remove(`bulk-${String(i).padStart(3, '0')}`, a)
  await engine!.pushNow()
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  let cursor = 0, pages = 0
  const deleted = new Set<string>()
  for (;;) {
    const data = (await api('/transcription_history/pull', { since: cursor, limit: 7 }, a.token)).data
    for (const id of data.deleted) { assert(!deleted.has(id)); deleted.add(id) }
    assert(data.cursor >= cursor); cursor = data.cursor; pages++
    if (!data.has_more) break
    assert(pages < 100)
  }
  assert(deleted.has('bulk-214') && deleted.size === 217 && pages > 1)
  ok('215 durable deletions drain in multiple batches and paginate without gaps or duplicate markers')

  await HistoryRepo.upsert(row('local-only'))
  await engine!.pushNow()
  await life.remove('local-only')
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  assert.equal((await api('/transcription_history/sync_status', {}, a.token)).data.total, 1)
  ok('local-only deletion does not silently delete a cloud copy')

  await HistoryRepo.upsert(row('disabled'))
  await engine!.pushNow()
  await life.remove('disabled', a)
  await engine!.updateSettings({ sync_enabled: false })
  await engine!.pushNow()
  assert.equal(HistoryRepo.cloudDeletionCount(a), 1)
  assert.equal((await api('/transcription_history/delete', { ids: ['disabled'] }, a.token)).detail, 'sync_disabled')
  await engine!.updateSettings({ sync_enabled: true })
  await engine!.pushNow()
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  ok('sync opt-out pauses deletion transmission until an explicit successful re-enable')

  await HistoryRepo.upsert({ ...row('legacy-download'), syncedFromCloud: true, userId: null, syncStatus: 'synced' })
  engine!.dispose(); closeDatabase()
  const file = join(root, device, 'db', 'opentype.db')
  const old = new Database(file)
  old.exec('ALTER TABLE history DROP COLUMN cloud_scope')
  old.close()
  openDevice(device)
  assert.equal(HistoryRepo.cloudDeletionCount(a), 0)
  assert(HistoryRepo.syncCursor(a) >= 0)
  assert.equal((await HistoryRepo.byId('legacy-download'))?.refinedText, 'Synthetic deletion test')
  await HistoryRepo.pendingSyncForApi(a.userId, 200, false, [], baseUrl)
  assert.equal((await HistoryRepo.byId('legacy-download'))?.userId, null)
  await life.applyRemoteDeletions(['legacy-download'], a)
  assert.equal(await HistoryRepo.byId('legacy-download'), null)
  const dbBytes = await readFile(file)
  assert(dbBytes.length > 0)
  ok('existing databases migrate the new scope column without losing deletion state')

  const serverDb = new Database(join(root, 'server.db'), { readonly: true })
  try {
    assert.deepEqual((serverDb.prepare('PRAGMA table_info(history_deletions)').all() as { name: string }[]).map(c => c.name), ['id', 'user_id', 'server_updated_at'])
    assert((serverDb.prepare('SELECT COUNT(*) AS n FROM history_deletions WHERE user_id = ?').get(a.userId) as { n: number }).n > 0)
    assert.equal((await api('/user/delete_account', { reason: 'disposable automated test' }, a.token)).status, 'OK')
    assert.equal((serverDb.prepare('SELECT COUNT(*) AS n FROM history_deletions WHERE user_id = ?').get(a.userId) as { n: number }).n, 0)
  } finally { serverDb.close() }
  ok('server deletion markers contain no text and account removal clears the markers')
  console.log(`${passed} real client/server deletion scenarios passed`)
} finally { engine?.dispose(); closeDatabase() }
