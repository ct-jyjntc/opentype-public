import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../src/db/index.ts'
import { AUTH_RECORD_CLEANUP_GRACE_MS, cleanupExpiredAuthRecords } from '../src/services/auth.ts'

const root = mkdtempSync(join(tmpdir(), 'opentype-auth-cleanup-'))
const now = 1_800_000_000_000
const cutoff = now - AUTH_RECORD_CLEANUP_GRACE_MS

try {
  const db = initDb({ path: join(root, 'auth.db') })
  db.prepare('INSERT INTO users (user_id, created_at, updated_at) VALUES (?, ?, ?)').run('user', now, now)

  const insertRefresh = db.prepare(
    'INSERT INTO refresh_tokens (token, user_id, issued_at, expires_at, session_id) VALUES (?, ?, ?, ?, ?)'
  )
  insertRefresh.run('expired-refresh', 'user', cutoff - 1000, cutoff - 1, 'session-expired')
  insertRefresh.run('boundary-refresh', 'user', cutoff - 1000, cutoff, 'session-boundary')
  insertRefresh.run('valid-refresh', 'user', now, now + 60_000, 'session-valid')

  const insertAuthCode = db.prepare(`
    INSERT INTO auth_codes (code, user_id, code_challenge, state, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertAuthCode.run('expired-code', 'user', 'challenge', 'state', cutoff - 1000, cutoff - 1)
  insertAuthCode.run('boundary-code', 'user', 'challenge', 'state', cutoff - 1000, cutoff)
  insertAuthCode.run('valid-code', 'user', 'challenge', 'state', now, now + 60_000)

  const insertEmailCode = db.prepare(`
    INSERT INTO email_codes (email, code, issued_at, expires_at) VALUES (?, ?, ?, ?)
  `)
  insertEmailCode.run('expired@example.test', '111111', cutoff - 1000, cutoff - 1)
  insertEmailCode.run('boundary@example.test', '222222', cutoff - 1000, cutoff)
  insertEmailCode.run('valid@example.test', '333333', now, now + 60_000)

  const insertResetCode = db.prepare(`
    INSERT INTO password_reset_codes (email, code, issued_at, expires_at) VALUES (?, ?, ?, ?)
  `)
  insertResetCode.run('expired-reset@example.test', '111111', cutoff - 1000, cutoff - 1)
  insertResetCode.run('boundary-reset@example.test', '222222', cutoff - 1000, cutoff)
  insertResetCode.run('valid-reset@example.test', '333333', now, now + 60_000)

  assert.deepEqual(cleanupExpiredAuthRecords(now), {
    refresh_tokens: 1,
    auth_codes: 1,
    email_codes: 1,
    password_reset_codes: 1
  })

  const tokens = db.prepare('SELECT token FROM refresh_tokens ORDER BY token').all().map(row => row.token)
  const authCodes = db.prepare('SELECT code FROM auth_codes ORDER BY code').all().map(row => row.code)
  const emailCodes = db.prepare('SELECT email FROM email_codes ORDER BY email').all().map(row => row.email)
  const resetCodes = db.prepare('SELECT email FROM password_reset_codes ORDER BY email').all().map(row => row.email)
  assert.deepEqual(tokens, ['boundary-refresh', 'valid-refresh'])
  assert.deepEqual(authCodes, ['boundary-code', 'valid-code'])
  assert.deepEqual(emailCodes, ['boundary@example.test', 'valid@example.test'])
  assert.deepEqual(resetCodes, ['boundary-reset@example.test', 'valid-reset@example.test'])

  assert.deepEqual(cleanupExpiredAuthRecords(now), {
    refresh_tokens: 0,
    auth_codes: 0,
    email_codes: 0,
    password_reset_codes: 0
  })
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM refresh_tokens').get().count, 2)
  console.log('OK auth cleanup removes only records beyond the grace period and is idempotent')
} finally {
  closeDb()
  rmSync(root, { recursive: true, force: true })
}
