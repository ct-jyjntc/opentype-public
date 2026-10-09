import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const preload = await readFile(new URL('../frontend/preload/runtime.cjs', import.meta.url), 'utf8')
const legacyPreload = await readFile(new URL('../frontend/preload/index.cjs', import.meta.url), 'utf8')
const uiConfig = await readFile(new URL('../frontend/renderer/static/js/DLh7vjiS.js', import.meta.url), 'utf8')

function loadRuntime(config) {
  const exposed = {}
  runInNewContext(preload, { require: name => {
    assert.equal(name, 'electron')
    return {
      ipcRenderer: { sendSync: channel => { assert.equal(channel, 'config:frontend-runtime'); return config } },
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }
    }
  } })
  return JSON.parse(JSON.stringify(exposed))
}

test('shipped preload loads public runtime config before legacy modules, excluding credentials', () => {
  assert.ok(legacyPreload.startsWith('require("./runtime.cjs");'))
  const result = loadRuntime({ cloudBaseUrl: 'https://server.example', appVersion: '0.2.0', provider: 'local', apiKey: 'secret', userData: 'secret' })
  assert.deepEqual(result, { opentypeRuntime: { cloudBaseUrl: 'https://server.example', appVersion: '0.2.0', provider: 'local', voiceTransport: 'ipc' } })
})

test('shipped API/web/version constants take the current config on each load', () => {
  const assignment = uiConfig.match(/const On=window\.opentypeRuntime\.cloudBaseUrl,In=window\.opentypeRuntime\.cloudBaseUrl,Pn=window\.opentypeRuntime\.appVersion/)
  assert.ok(assignment, 'shipped config must use the runtime bridge')
  assert.ok(!uiConfig.includes('http://192.0.2.1:9100'))
  for (const host of ['http://127.0.0.1:19100', 'https://second.example']) {
    const window = loadRuntime({ cloudBaseUrl: host, appVersion: '0.2.1', provider: 'openai' })
    const values = runInNewContext(assignment[0] + '; JSON.stringify([On, In, Pn])', { window })
    assert.deepEqual(JSON.parse(values), [host, host, '0.2.1'])
  }
})

test('missing runtime config fails visibly instead of silently using an old server', () => {
  assert.throws(() => loadRuntime(null), /runtime configuration unavailable/)
})
