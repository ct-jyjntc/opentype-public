import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { SecureConfigStore, type SecretEncryption } from '../src/main/services/secure-store'

const key = randomBytes(32)
const encryption: SecretEncryption = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(value), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  },
  decryptString(value) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString()
  }
}

function fixture(initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opentype-secret-test-')), path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(initial))
  return {
    backend: {
      get store(): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')) },
      set(values: Record<string, unknown>) { writeFileSync(path, JSON.stringify({ ...this.store, ...values })) }
    },
    disk: () => readFileSync(path, 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

test('migrates both account copies and the API key; survives a new store instance', () => {
  const initial = { apiKey: 'test-api-secret', refineApiKey: 'test-refine-secret', userData: JSON.stringify({ access_token: 'test-access-secret' }),
    'app-storage': { userData: { refresh_token: 'test-refresh-secret', role: { name: 'pro' } } },
    'app-settings': { selectedLanguages: ['zh-CN'] }, provider: 'openai' }
  const f = fixture(initial)
  try {
    const store = new SecureConfigStore(f.backend, encryption)
    for (const value of ['test-api-secret', 'test-refine-secret', 'test-access-secret', 'test-refresh-secret']) assert.ok(!f.disk().includes(value))
    assert.deepEqual(store.store, initial)
    const restarted = new SecureConfigStore(f.backend, encryption)
    assert.deepEqual(restarted.store, initial)
    restarted.set({ apiKey: 'new-api-secret', provider: 'local' })
    assert.ok(!f.disk().includes('new-api-secret'))
    assert.equal(new SecureConfigStore(f.backend, encryption).get('apiKey'), 'new-api-secret')
  } finally { f.cleanup() }
})

test('legacy renderer get/set/delete pattern remains compatible without plaintext writes', () => {
  const f = fixture()
  try {
    const store = new SecureConfigStore(f.backend, encryption)
    store.set({ 'app-storage': { userData: { access_token: 'renderer-token' }, locale: 'zh' } })
    const all = store.get('app-storage') as Record<string, unknown>
    all.locale = 'en'
    store.set({ 'app-storage': all })
    assert.deepEqual((store.get('app-storage') as any).userData, { access_token: 'renderer-token' })
    delete all.userData
    store.set({ 'app-storage': all, userData: '', apiKey: '' })
    assert.deepEqual(new SecureConfigStore(f.backend, encryption).get('app-storage'), { locale: 'en' })
    assert.ok(!f.disk().includes('renderer-token'))
  } finally { f.cleanup() }
})

for (const mode of ['unavailable', 'basic_text', 'encrypt_throws']) {
  test(`${mode}: keeps credentials only in memory, including migrated plaintext`, () => {
    const f = fixture({ apiKey: 'legacy-secret' }), issues: string[] = []
    try {
      const crypto = { ...encryption,
        isEncryptionAvailable: () => mode !== 'unavailable',
        getSelectedStorageBackend: () => mode === 'basic_text' ? 'basic_text' : 'keychain',
        encryptString: () => { throw new Error('locked') }
      }
      const store = new SecureConfigStore(f.backend, crypto, (issue) => issues.push(issue))
      assert.equal(store.get('apiKey'), 'legacy-secret')
      assert.ok(!f.disk().includes('legacy-secret'))
      store.set({ userData: 'session-token' })
      assert.equal(store.get('userData'), 'session-token')
      assert.ok(!f.disk().includes('session-token'))
      assert.deepEqual(issues, ['session_only'])
      assert.equal(new SecureConfigStore(f.backend, encryption).get('apiKey'), '')
    } finally { f.cleanup() }
  })
}

test('unreadable ciphertext is preserved for recovery and never returned as a credential', () => {
  const f = fixture(), issues: string[] = []
  try {
    new SecureConfigStore(f.backend, encryption).set({ apiKey: 'protected-secret' })
    const original = f.disk()
    const locked = new SecureConfigStore(f.backend, { ...encryption, decryptString: () => { throw new Error('locked') } }, issue => issues.push(issue))
    assert.equal(locked.get('apiKey'), '')
    assert.equal(locked.get('apiKey'), '')
    locked.set({ provider: 'local' })
    assert.deepEqual(JSON.parse(f.disk()).apiKey, JSON.parse(original).apiKey)
    assert.deepEqual(issues, ['decrypt_failed'])
    assert.equal(new SecureConfigStore(f.backend, encryption).get('apiKey'), 'protected-secret')
  } finally { f.cleanup() }
})
