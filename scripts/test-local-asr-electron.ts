import { app, utilityProcess } from 'electron'
import { mkdtempSync, readFileSync, rmSync, copyFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { decodeLocalAudio } from '../src/main/services/local-asr/audio-decode'
import { LocalAsrProcess } from '../src/main/services/local-asr/process'
import { NativeLocalProvider } from '../src/main/services/providers/native-local'
import { encodeWav } from '../src/main/services/pcm'
import { applyPendingRefinement, REFINEMENT_SETUP_FILE } from '../src/main/services/refinement-setup'
import { SecureConfigStore } from '../src/main/services/secure-store'
import { safeStorage } from 'electron'
import { SenseVoiceModelStore } from '../src/main/services/local-asr/model-store'

const dir = mkdtempSync(join(tmpdir(), 'opentype-native-asr-check-'))
app.setName('OpenType'); app.setPath('userData', dir)
app.whenReady().then(async () => {
  let code = 0, spawned = 0
  const engine = new LocalAsrProcess(() => {
    spawned++
    const child = utilityProcess.fork(process.env.OPENTYPE_ASR_TEST_WORKER ?? resolve('dist/main/sensevoice-worker.js'), [], { serviceName: 'OpenType ASR test', stdio: 'pipe' })
    child.stderr?.on('data', chunk => process.stderr.write(chunk))
    return child
  }, join(dir, 'models'), 30_000, 100)
  try {
    const modelSource = process.env.OPENTYPE_ASR_TEST_MODEL_DIR ?? resolve('gateway/models/sensevoice-int8')
    const models = new SenseVoiceModelStore(join(dir, 'models'))
    assert.equal((await models.importBundle(modelSource)).state, 'ready')
    const modelMtime = statSync(join(dir, 'models/model.int8.onnx')).mtimeMs
    assert.equal((await models.importBundle(modelSource)).state, 'ready')
    assert.equal(statSync(join(dir, 'models/model.int8.onnx')).mtimeMs, modelMtime)
    writeFileSync(join(dir, 'models/tokens.txt'), 'corrupt tokens')
    const repaired = new SenseVoiceModelStore(join(dir, 'models'))
    assert.equal((await repaired.importBundle(modelSource)).state, 'ready')
    console.log('OK bundled model checksum, first-run copy, existing-model retention and corrupt-token repair')
    const aiff = join(dir, 'sample.aiff'), wav = join(dir, 'sample.wav'), ogg = join(dir, 'sample.ogg')
    execFileSync('say', ['-v', 'Tingting', '-r', '175', '-o', aiff, '明天下午三点开会，讨论下个季度的产品路线图。'], { stdio: 'ignore' })
    execFileSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', wav], { stdio: 'ignore' })
    execFileSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', ogg], { stdio: 'ignore' })
    const audio = readFileSync(wav)
    const transcript = await engine.transcribe(audio)
    assert(!transcript.error, JSON.stringify(transcript))
    assert.match(transcript.text!, /明天下午3点开会/)
    const compressed = await engine.transcribe(readFileSync(ogg))
    assert(!compressed.error, JSON.stringify(compressed))
    assert.match(compressed.text!, /明天下午3点开会/)
    console.log('OK Electron utility process decodes real WAV and Ogg Opus with SenseVoice:', transcript.text)
    const silent = await engine.transcribe(encodeWav([new Float32Array(16000)], 16000))
    assert.equal(silent.text, '')
    assert.equal((await engine.transcribe(new Uint8Array([1, 2, 3]))).error, 'unsupported_audio_format')
    assert.equal((await engine.transcribe(encodeWav([new Float32Array(16000 * 31)], 16000))).text, '')
    const decoded = await decodeLocalAudio(audio)
    const repeat = Math.ceil(75 * 16000 / decoded.samples.length)
    const longAudio = encodeWav(Array.from({length: repeat}, () => decoded.samples),16000)
    const longResult = await engine.transcribe(longAudio)
    assert(!longResult.error, JSON.stringify(longResult))
    assert((longResult.text?.match(/明天下午3点开会/g)?.length ?? 0) >= repeat - 1, String(longResult.text))
    console.log('OK real SenseVoice transcribes more than 75 seconds without Whisper:', repeat, 'utterances')
    console.log('OK silence and corrupt format; no duration rejection')
    const controller = new AbortController()
    const pending = engine.transcribe(audio, controller.signal)
    assert.equal((await engine.transcribe(audio)).error, 'local_asr_busy')
    controller.abort()
    assert.equal((await pending).error, 'cancelled')
    assert.match((await engine.transcribe(audio)).text!, /明天下午3点开会/)
    assert.equal(spawned, 2)
    console.log('OK busy request is bounded, cancellation kills inference, next request restarts successfully')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.match((await engine.transcribe(audio)).text!, /明天下午3点开会/)
    assert.equal(spawned, 3)
    console.log('OK idle shutdown frees the model and next request reloads it')
    const provider = new NativeLocalProvider(engine,
      { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', enabled: false })
    const params = { mode: 'voice_transcript' as const, audio, duration: 5, audioId: 'test', audioMetadata: {}, audioContext: {}, parameters: { language: 'zh-CN' } }
    assert.equal((await provider.transcribe(params)).success, true)
    assert.equal((await provider.transcribe({ ...params, parameters: { language: 'fr' } })).detail, 'unsupported_language')
    assert.match((await provider.transcribe({ ...params, duration: 60 })).text!, /明天下午3点开会/)
    assert.equal((await provider.transcribe({ ...params, signal: AbortSignal.abort() })).detail, 'cancelled')
    console.log('OK native provider stays on SenseVoice, reports unsupported languages and accepts long durations')
    // Verify a real pending OS-encrypted key without changing the user's pending setup or live config.
    if (process.env.OPENTYPE_CHECK_PENDING_REFINEMENT) {
      const path = join(dir, REFINEMENT_SETUP_FILE)
      copyFileSync(join(process.env.OPENTYPE_CHECK_PENDING_REFINEMENT, REFINEMENT_SETUP_FILE), path)
      const { default: Store } = await import('electron-store')
      const backend = new Store({ cwd: dir, name: 'secure-test' })
      const store = new SecureConfigStore(backend, safeStorage, () => { throw new Error('secure_store_failed') })
      assert.equal(await applyPendingRefinement(path, safeStorage, store), true)
      const key = store.get('refineApiKey') as string
      assert(key.startsWith('sk-'))
      assert(!readFileSync(join(dir, 'secure-test.json'), 'utf8').includes(key))
      assert.equal(new SecureConfigStore(new Store({ cwd: dir, name: 'secure-test' }), safeStorage).get('refineApiKey'), key)
      console.log('OK real DeepSeek key decrypted, imported, re-encrypted on disk, reopened; user config untouched')
    }
  } catch (err) { console.error(err); code = 1 }
  finally { engine.dispose(); rmSync(dir, { recursive: true, force: true }); app.exit(code) }
})
