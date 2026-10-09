import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initDb, closeDb, getDb } from '../src/db/index.ts'
import { expireCloudHistory, getSyncStatus, pushHistory, updateSyncSettings, wipeHistory } from '../src/services/history.ts'
const root = mkdtempSync(join(tmpdir(), 'opentype-cloud-migration-'))
let passed = 0
const ok = s => { passed++; console.log('OK ' + s) }
try {
  const path = join(root, 'old.db'), old = new DatabaseSync(path), baseline = Date.now() - 8 * 86400000
  old.exec(`CREATE TABLE history(id TEXT, user_id TEXT, status TEXT, mode TEXT, refined_text TEXT, duration REAL, created_at TEXT, updated_at TEXT, server_updated_at INTEGER NOT NULL, audio_local_path TEXT, audio_metadata TEXT, app_version TEXT, mic_device TEXT, mic_device_info BLOB, client_metadata BLOB, mode_meta BLOB, debug_info TEXT, audio_context TEXT, PRIMARY KEY(id,user_id)); CREATE TABLE sync_settings(user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE, cloud_retention INTEGER DEFAULT -1, sync_enabled INTEGER DEFAULT 1, purge_before_at INTEGER, updated_at INTEGER NOT NULL);`)
  old.prepare('INSERT INTO history(id,user_id,status,refined_text,server_updated_at) VALUES (?,?,?,?,?)').run('legacy','user','completed','legacy text',baseline)
  old.close()
  const db = initDb({ path })
  db.prepare('INSERT INTO users(user_id,created_at,updated_at) VALUES (?,?,?)').run('user',1,1)
  assert.equal(db.prepare('SELECT cloud_received_at FROM history').get().cloud_received_at, baseline)
  assert.equal(getSyncStatus('user').cloud_epoch, 0)
  pushHistory('user', [{ id:'legacy', status:'completed', refined_text:'edited legacy' }])
  assert.equal(db.prepare('SELECT cloud_received_at FROM history').get().cloud_received_at, baseline)
  assert.equal(updateSyncSettings('user', { cloud_retention:7 }).total, 0)
  ok('legacy migration uses last known server time and later updates never extend it')

  pushHistory('user', [{id:'startup',status:'completed',refined_text:'startup content'}])
  db.prepare('UPDATE history SET cloud_received_at=? WHERE id=?').run(baseline,'startup')
  closeDb(); initDb({ path })
  assert.equal(expireCloudHistory(), 1)
  assert.equal(getSyncStatus('user').total, 0)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM history_cloud_evictions').get().n,2)
  ok('persisted retention survives restart and startup cleanup generates cloud-only markers')

  pushHistory('user', [{id:'transaction',status:'completed',refined_text:'keep until commit'}])
  getDb().exec("CREATE TRIGGER fail_wipe BEFORE INSERT ON history_cloud_wipes BEGIN SELECT RAISE(ABORT, 'test disk error'); END;")
  assert.throws(()=>wipeHistory('user','atomic-request'), /test disk error/)
  assert.equal(getSyncStatus('user').total,1)
  assert.equal(getSyncStatus('user').cloud_epoch,0)
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM history_cloud_evictions WHERE id='transaction'").get().n,0)
  getDb().exec('DROP TRIGGER fail_wipe')
  assert.deepEqual(wipeHistory('user','atomic-request'),{deleted:1,cloud_epoch:1})
  ok('failed wipe transaction rolls back content, epoch and eviction marker together')

  getDb().prepare('DELETE FROM users WHERE user_id=?').run('user')
  for (const table of ['history_cloud_evictions','history_cloud_wipes','sync_settings']) assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0)
  ok('account removal cascades cloud lifecycle metadata with no transcript payloads')
  console.log(`${passed} server migration and transaction scenarios passed`)
} finally { closeDb(); rmSync(root,{recursive:true,force:true}) }
