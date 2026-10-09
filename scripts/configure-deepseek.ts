// Run with Electron (GUI runtime). Key is read from stdin, never command arguments or logs.
import { app, safeStorage } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { REFINEMENT_SETUP_FILE } from '../src/main/services/refinement-setup'
import { refineTranscript } from '../src/main/services/providers/refinement'

const target = process.argv[2]
if (!target || !isAbsolute(target)) throw new Error('Pass an absolute OpenType user data directory')
const dir = mkdtempSync(join(tmpdir(), 'opentype-refinement-setup-'))
app.setName('OpenType')
app.setPath('userData', dir)
app.whenReady().then(async () => {
  let exitCode = 0
  const input = createInterface({ input: process.stdin, terminal: false })
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable')
    const keyReady = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('key_input_timeout')), 60_000)
      input.once('line', value => { clearTimeout(timer); resolve(value) })
      input.once('close', () => { clearTimeout(timer); reject(new Error('key_input_closed')) })
    })
    console.log('ready_for_key')
    const key = (await keyReady).trim()
    if (!key.startsWith('sk-') || key.length < 20) throw new Error('invalid_key')
    const config = { provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: key, enabled: true }
    const cases = [
      { id: 'correction', mode: 'voice_transcript' as const, raw: '嗯那个明天周三开会，不对改成周四上午十点，通知产品组和研发组。', parameters: {} },
      { id: 'translation', mode: 'voice_translation' as const, raw: '请在周四上午十点开会。', parameters: { output_language: 'en' } },
      { id: 'edit', mode: 'voice_command' as const, raw: '把这句话改得礼貌一点。', parameters: { selected_text: '把报告发给我。' } }
    ]
    const results = []
    for (const c of cases) {
      const started = performance.now()
      const result = await refineTranscript(c.raw, { mode: c.mode, audio: new Uint8Array(), audioId: 'synthetic-refinement-check',
        duration: 0, audioMetadata: {}, audioContext: {}, parameters: c.parameters }, config)
      if (!result.success || result.detail) throw new Error(`official_api_check_failed_${c.id}`)
      results.push({ id: c.id, rawText: c.raw, text: result.text, elapsedMs: Math.round(performance.now() - started) })
    }
    const payload = { refineBaseUrl: config.baseUrl, refineModel: config.model, refineApiKey: key }
    const ciphertext = safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
    if (safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) !== JSON.stringify(payload)) throw new Error('secret_roundtrip_failed')
    mkdirSync(target, { recursive: true })
    const pending = join(target, REFINEMENT_SETUP_FILE), temporary = pending + '.tmp'
    writeFileSync(temporary, JSON.stringify({ version: 1, ciphertext }), { mode: 0o600 })
    renameSync(temporary, pending)
    console.log(JSON.stringify({ saved: true, activation: 'next OpenType source build launch', officialEndpoint: config.baseUrl,
      model: config.model, thinking: 'disabled', validation: 'all responses stopped normally, contained text, and contained no reasoning', results }))
  } catch (err) {
    // Never print the key or upstream response bodies.
    console.error('DeepSeek setup failed:', (err as Error).message)
    exitCode = 1
  } finally {
    input.close(); rmSync(dir, { recursive: true, force: true }); app.exit(exitCode)
  }
})
