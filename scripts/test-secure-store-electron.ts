// Optional host smoke test: real Electron safeStorage + electron-store in a temporary directory.
import { app, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureConfigStore } from '../src/main/services/secure-store'

const dir = mkdtempSync(join(tmpdir(), 'opentype-os-secret-test-'))
app.setPath('userData', dir)
app.whenReady().then(async () => {
  let exitCode = 0
  try {
    assert.ok(safeStorage.isEncryptionAvailable(), 'OS key store unavailable: host verification cannot pass')
    const { default: Store } = await import('electron-store')
    const backend = new Store({ cwd: dir, name: 'config', projectVersion: '0.1.0' })
    backend.set({ apiKey: 'synthetic-api-key', userData: JSON.stringify({ access_token: 'synthetic-access-token' }),
      'app-storage': { userData: { refresh_token: 'synthetic-refresh-token' } }, provider: 'openai',
      apiBaseUrl: 'https://non-default.example' })
    const store = new SecureConfigStore(backend, safeStorage, issue => { throw new Error(issue) })
    const serialized = readFileSync(join(dir, 'config.json'), 'utf8')
    for (const secret of ['synthetic-api-key', 'synthetic-access-token', 'synthetic-refresh-token']) {
      assert.ok(!serialized.includes(secret), 'plaintext reached disk')
    }
    const reopened = new SecureConfigStore(new Store({ cwd: dir, name: 'config', projectVersion: '0.1.0' }), safeStorage)
    assert.deepEqual(reopened.store, store.store)
    assert.equal(reopened.get('apiKey'), 'synthetic-api-key')
    assert.equal(reopened.get('apiBaseUrl'), 'https://non-default.example')
    console.log('Electron safeStorage: encrypted migration, disk inspection and reopen passed')
  } catch (err) {
    console.error('Electron safeStorage smoke failed:', (err as Error).message)
    exitCode = 1
  } finally { rmSync(dir, { recursive: true, force: true }) }
  app.exit(exitCode)
})
