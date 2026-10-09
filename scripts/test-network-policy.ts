import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { AuthService, type AuthUser } from '../src/main/services/auth'
import { ApiClient } from '../src/main/services/api'
import { CustomProvider } from '../src/main/services/providers/custom'
import { OpenAIProvider } from '../src/main/services/providers/openai'
import { LocalProvider } from '../src/main/services/providers'
import { serviceRequest } from '../src/main/services/network'
import { fetchPublicHttps } from '../src/main/services/public-download'
import { serviceEndpoint, serviceScope, serviceToken, networkSettingsPatch } from '../src/shared/network-policy'
import { OAUTH_ENDPOINTS } from '../src/main/services/protocol'
import type { TranscribeParams } from '../src/main/services/providers/types'

let passed = 0
async function test(name: string, run: () => Promise<void> | void) { await run(); passed++; console.log('OK ' + name) }
const user: AuthUser = { user_id: 'synthetic-user', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: 1 }
const params: TranscribeParams = { mode: 'voice_transcript', audio: new TextEncoder().encode('synthetic-audio'), audioId: 'synthetic', duration: 1, audioContext: { input_context: 'synthetic-context' }, audioMetadata: {} }
function authAt(baseUrl: string, initial: AuthUser | null = null) {
  let stored = initial
  const options = { apiBaseUrl: baseUrl, webBaseUrl: baseUrl, appVersion: 'test', load: async () => stored, save: async (value: AuthUser | null) => { stored = value } }
  return { service: new AuthService(options), options, stored: () => stored }
}
const original = getGlobalDispatcher(), mock = new MockAgent()
mock.disableNetConnect(); mock.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(mock)
let leakedRequests = 0
mock.get('http://unsafe.example').intercept({ path: /.*/, method: /.*/ }).reply(() => { leakedRequests++; return { statusCode: 200, data: {} } }).persist()
try {
  await test('service identity retains base paths and permits HTTPS or loopback HTTP only', () => {
    assert.equal(serviceEndpoint('https://EXAMPLE.com:443/api/', '/oauth/login'), 'https://example.com/api/oauth/login')
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert(serviceEndpoint(`http://${host}:8090`).startsWith('http:'))
    for (const bad of ['http://unsafe.example', 'http://192.168.1.5', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'ftp://localhost']) assert.throws(() => serviceEndpoint(bad), /insecure_cloud_url/)
    for (const bad of ['https://user:password@example.com', 'https://example.com?key=synthetic', 'https://example.com/#fragment', 'bad']) assert.throws(() => serviceEndpoint(bad), /invalid_cloud_url/)
    assert.throws(() => serviceEndpoint(''), /cloud_not_configured/)
    assert.equal(serviceScope('bad'), 'bad')
  })
  await test('password login and registration reject insecure destinations before any request', async () => {
    const { service } = authAt('http://unsafe.example')
    assert.equal((await service.loginWithPassword('synthetic@invalid', 'synthetic-password')).detail, 'insecure_cloud_url')
    assert.equal((await service.register('synthetic@invalid', 'synthetic-password')).detail, 'insecure_cloud_url')
    assert.throws(() => service.createLoginUrl(), /insecure_cloud_url/)
    assert.equal(leakedRequests, 0)
  })
  await test('refresh, access-token access and logout cannot transmit to an insecure saved service', async () => {
    const fixture = authAt('http://unsafe.example', user)
    await fixture.service.initialize()
    assert.equal(await fixture.service.refresh(), false)
    await assert.rejects(fixture.service.getAccessToken(), /insecure_cloud_url/)
    assert.equal(fixture.stored()?.access_token, user.access_token)
    await fixture.service.logout()
    assert.equal(fixture.stored(), null)
    assert.equal(leakedRequests, 0)
  })
  await test('PKCE exchange revalidates its destination before sending the verifier', async () => {
    const { service, options } = authAt('https://allowed.example/base')
    const login = new URL(service.createLoginUrl())
    assert(login.pathname.startsWith('/base/'))
    options.apiBaseUrl = 'http://unsafe.example'
    assert.equal((await service.exchangeLoginCode('synthetic-code', login.searchParams.get('state')!)).detail, 'insecure_cloud_url')
    assert.equal(leakedRequests, 0)
  })
  await test('legacy API audio/history/blacklist/refresh requests share the guard', async () => {
    let tokens = 0
    const client = new ApiClient({ baseUrl: 'http://unsafe.example', appVersion: 'test', getToken: async () => { tokens++; return user.access_token }, getDeviceId: () => 'synthetic-device' })
    assert.equal((await client.voiceFlow(params)).detail, 'insecure_cloud_url')
    await assert.rejects(client.pushHistory([{ id: 'synthetic', refined_text: 'synthetic-text' }]), /insecure_cloud_url/)
    await assert.rejects(client.fetchBlacklistDomains(), /insecure_cloud_url/)
    await assert.rejects(client.refreshToken(user.refresh_token!), /insecure_cloud_url/)
    assert.equal(tokens, 0); assert.equal(leakedRequests, 0)
  })
  await test('custom and OpenAI audio uploads refuse plaintext and do not read account credentials', async () => {
    let tokens = 0
    const config = { baseUrl: 'http://unsafe.example', appVersion: 'test', apiKey: 'synthetic-api-key', getToken: async () => { tokens++; return user.access_token } }
    assert.equal((await new CustomProvider({ ...config, kind: 'custom' }).transcribe(params)).detail, 'insecure_cloud_url')
    assert.equal((await new OpenAIProvider({ ...config, kind: 'openai' }).transcribe(params)).detail, 'insecure_cloud_url')
    assert.equal((await new LocalProvider({ ...config, kind: 'local' }).transcribe(params)).detail, 'invalid_local_endpoint')
    assert.equal(tokens, 0); assert.equal(leakedRequests, 0)
  })
  await test('account tokens are tied to the full service base, including port and path', async () => {
    let tokens = 0
    const getter = async () => { tokens++; return user.access_token }
    for (const dest of ['https://other.example', 'https://account.example:8443/base', 'https://account.example/other']) {
      assert.equal(await serviceToken(dest, 'https://account.example/base', getter), null)
    }
    assert.equal(tokens, 0)
    assert.equal(await serviceToken('https://account.example/base/', 'https://account.example/base', getter), user.access_token)
    assert.equal(tokens, 1)
  })
  await test('explicit custom API key is used without taking an unrelated account token', async () => {
    let tokens = 0
    mock.get('https://custom.example').intercept({ path: '/ai/voice_flow', method: 'POST' }).reply(opts => {
      assert(JSON.stringify(opts.headers).includes('synthetic-custom-key'))
      assert(!JSON.stringify(opts.headers).includes(user.access_token))
      return { statusCode: 200, data: { status: 'OK', data: { refine_text: 'result', raw_text: 'raw' } } }
    })
    const result = await new CustomProvider({ kind: 'custom', baseUrl: 'https://custom.example', apiKey: 'synthetic-custom-key', appVersion: 'test', getToken: async () => { tokens++; return user.access_token } }).transcribe(params)
    assert.equal(result.text, 'result'); assert.equal(tokens, 0)
  })
  await test('changing a voice endpoint clears its old API key, while normalization preserves the same service', () => {
    const current = { apiBaseUrl: 'https://voice.example/base/', apiKey: 'synthetic-old', cloudBaseUrl: 'https://account.example' }
    assert.equal(networkSettingsPatch(current, { apiBaseUrl: 'https://other.example' }).apiKey, '')
    assert.equal(networkSettingsPatch(current, { apiBaseUrl: 'https://voice.example/base' }).apiKey, undefined)
    assert.equal(networkSettingsPatch(current, { apiBaseUrl: 'https://other.example', apiKey: 'synthetic-new' }).apiKey, 'synthetic-new')
    assert.equal(networkSettingsPatch(current, { cloudBaseUrl: ' ' }).cloudBaseUrl, '')
    assert.throws(() => networkSettingsPatch(current, { cloudBaseUrl: 'http://unsafe.example' }), /insecure_cloud_url/)
    assert.throws(() => networkSettingsPatch(current, { apiBaseUrl: undefined }), /invalid_cloud_url/)
  })
  await test('HTTPS service redirects never replay credentials, bodies or login results', async () => {
    for (const code of [301, 302, 303, 307, 308]) {
      mock.get('https://redirect.example').intercept({ path: '/oauth/login', method: 'POST' }).reply(code, { status: 'OK', data: user }, { headers: { location: 'http://unsafe.example/trap' } })
      assert.equal((await authAt('https://redirect.example').service.loginWithPassword('synthetic', 'synthetic')).detail, 'service_redirect_refused')
    }
    assert.equal(leakedRequests, 0)
  })
  await test('legitimate HTTPS login and audio response still work through the protected request', async () => {
    mock.get('https://allowed.example').intercept({ path: '/oauth/login', method: 'POST' }).reply(200, { status: 'OK', data: user })
    const login = authAt('https://allowed.example')
    assert.equal((await login.service.loginWithPassword('synthetic', 'synthetic')).success, true)
    mock.get('https://allowed.example').intercept({ path: '/v1/audio/transcriptions', method: 'POST' }).reply(200, { text: 'synthetic transcript' })
    const result = await new OpenAIProvider({ kind: 'openai', baseUrl: 'https://allowed.example', appVersion: 'test', apiKey: 'synthetic', refine: false }).transcribe(params)
    assert.equal(result.text, 'synthetic transcript')
  })
} finally { setGlobalDispatcher(original); await mock.close() }

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { resolve, promise } }
await test('late refresh body after logout cannot restore the old account', async () => {
  const entered = deferred(), release = deferred()
  const server = createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders()
    if (req.url === OAUTH_ENDPOINTS.REFRESH_TOKEN) { entered.resolve(); await release.promise; res.end(JSON.stringify({ status: 'OK', data: { access_token: 'late-old-token' } })) }
    else res.end(JSON.stringify({ status: 'OK', data: {} }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const fixture = authAt(`http://127.0.0.1:${(server.address() as { port: number }).port}`, user)
    await fixture.service.initialize()
    const pending = fixture.service.getAccessToken(); await entered.promise
    await fixture.service.logout(); release.resolve()
    assert.equal(await pending, null); assert.equal(fixture.stored(), null); assert.equal(fixture.service.userId, null)
  } finally { release.resolve(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})
await test('newer login wins over an older response and logout invalidates an initial pending login', async () => {
  for (const logout of [false, true]) {
    const entered = deferred(), release = deferred(); let requests = 0
    const server = createServer(async (_req, res) => {
      const index = ++requests
      res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders()
      if (index === 1) { entered.resolve(); await release.promise }
      res.end(JSON.stringify({ status: 'OK', data: { ...user, user_id: `synthetic-${index}` } }))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const fixture = authAt(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
      const pending = fixture.service.loginWithPassword('first', 'synthetic'); await entered.promise
      if (logout) await fixture.service.logout()
      else assert.equal((await fixture.service.loginWithPassword('second', 'synthetic')).success, true)
      release.resolve(); assert.equal((await pending).detail, 'session_changed')
      assert.equal(fixture.service.userId, logout ? null : 'synthetic-2')
    } finally { release.resolve(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  }
})
await test('untrusted TLS certificates fail before the server receives HTTP headers or a body', async () => {
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
  const dir = mkdtempSync(join(tmpdir(), 'opentype-tls-test-'))
  let requests = 0
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
    const server = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => { requests++; res.end('{}') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      await assert.rejects(serviceRequest(`https://127.0.0.1:${(server.address() as { port: number }).port}/`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: 'synthetic-only' }), /certificate|self.signed/i)
      assert.equal(requests, 0)
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await test('public downloads follow HTTPS CDN redirects but reject downgrade and bounded redirect loops', async () => {
  const originalFetch = globalThis.fetch
  let calls: string[] = []
  try {
    globalThis.fetch = async (input, options) => {
      calls.push(String(input))
      assert.equal(options?.redirect, 'manual'); assert.equal(options?.credentials, 'omit')
      assert(!JSON.stringify(options?.headers).toLowerCase().includes('authorization'))
      return calls.length === 1 ? new Response('', { status: 302, headers: { location: 'https://cdn.example/file?signature=synthetic' } }) : new Response('synthetic-model')
    }
    assert.equal(await (await fetchPublicHttps('https://origin.example/model')).text(), 'synthetic-model')
    assert.equal(calls.length, 2)
    calls = []
    globalThis.fetch = async input => { calls.push(String(input)); return new Response('', { status: 302, headers: { location: 'http://unsafe.example/model' } }) }
    await assert.rejects(fetchPublicHttps('https://origin.example/model'), /insecure_download_url/)
    assert.equal(calls.length, 1)
    calls = []
    globalThis.fetch = async input => { calls.push(String(input)); return new Response('', { status: 302, headers: { location: '/loop' } }) }
    await assert.rejects(fetchPublicHttps('https://origin.example/model'), /download_redirect_failed/)
    assert.equal(calls.length, 9)
  } finally { globalThis.fetch = originalFetch }
})
console.log(`${passed} network policy scenarios passed`)
