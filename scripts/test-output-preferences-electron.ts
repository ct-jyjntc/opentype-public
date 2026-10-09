import { app, utilityProcess } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CaptureSession } from '../src/main/services/capture-session'
import { LocalAsrProcess } from '../src/main/services/local-asr/process'
import { NativeLocalProvider } from '../src/main/services/providers/native-local'
import { decodeLocalAudio } from '../src/main/services/local-asr/audio-decode'
import { formatDictation } from '../src/main/services/output-format'
import type { HistoryInsert, HistoryRow } from '../src/main/db'
import type { SpeechProvider } from '../src/main/services/providers/types'

const dir = mkdtempSync(join(tmpdir(), 'opentype-output-asr-'))
app.setName('OpenType output test'); app.setPath('userData', dir)
app.whenReady().then(async () => {
  let code = 0
  const engine = new LocalAsrProcess(() => utilityProcess.fork(resolve('dist/main/sensevoice-worker.js'), [], {
    serviceName: 'OpenType output test', stdio: 'pipe',
  }), resolve('gateway/models/sensevoice-int8'))
  try {
    execFileSync('say', ['-v', 'Tingting', '-r', '175', '-o', join(dir, 'test.aiff'), '明天下午三点开会，检查八十五个文件。'], { stdio: 'ignore' })
    execFileSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', join(dir, 'test.aiff'), '-ar', '16000', '-ac', '1', join(dir, 'test.wav')], { stdio: 'ignore' })
    const audio = readFileSync(join(dir, 'test.wav')), pcm = (await decodeLocalAudio(audio)).samples
    const provider = new NativeLocalProvider(engine, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'unused', enabled: false })
    const output = { punctuation: 'chinese', spacing: 'space', expression: 'formal' } as const
    const report = []
    for (const live of [false, true]) {
      const selected: SpeechProvider = live ? provider : { name: provider.name, transcribe: p => provider.transcribe(p) }
      const rows = new Map<string, HistoryInsert>(), injected: string[] = []
      const session = new CaptureSession({
        provider: selected,
        context: () => ({ appName: 'Synthetic editor', bundleId: 'test.editor', audioContext: {}, selectedText: '' }),
        getConfig: () => ({ mode: 'voice_transcript', outputLanguage: 'en', asrLanguage: 'zh', autoInject: true, blacklistDomains: [], appVersion: 'test' }),
        notify() {}, flush: async () => {}, saveAudio: async () => join(dir, 'test.wav'),
        saveHistory: async row => { rows.set(row.id, { ...rows.get(row.id), ...row }) },
        loadHistory: async id => rows.get(id) as HistoryRow ?? null,
        inject: async text => { injected.push(text) }, showCard() {}, changed() {},
        personalization: async () => ({ output_preferences: output }),
      })
      try {
        const start = await session.onStart()
        for (let at = 0; at < pcm.length; at += 1024) session.pushAudio(pcm.subarray(at, at + 1024), 16000, 0)
        const result = await session.onStop()
        assert(result?.success && result.rawText, JSON.stringify(result))
        assert.match(result.rawText, /\d/)
        assert.notEqual(result.text, result.rawText, 'The real model sample must exercise local spacing')
        assert.equal(result.text, formatDictation(result.rawText, output))
        assert.deepEqual(injected, [result.text])
        assert.equal(JSON.parse(String(rows.get(start!.audioId)?.modeMeta)).raw_text, result.rawText)
        const retry = await session.voiceFlowForRenderer({ audioId: start!.audioId, arrayBuffer: audio, isRetry: true })
        assert(retry.success && retry.raw_text)
        assert.equal(retry.refine_text, formatDictation(retry.raw_text, output))
        assert.equal(injected.length, 1)
        report.push({ live, raw: result.rawText, output: result.text, retryRaw: retry.raw_text, retryOutput: retry.refine_text })
        console.log('OK real SenseVoice ' + (live ? 'incremental' : 'single shot') + ', offline formatting, raw history and retry')
      } finally { session.dispose() }
    }
    mkdirSync('tmp/output-preferences', { recursive: true })
    writeFileSync('tmp/output-preferences/real-model.json', JSON.stringify({ input: 'macOS Tingting synthetic audio; no microphone or actual paste', refinementEnabled: false, report }, null, 2) + '\n')
  } catch (error) { console.error(error); code = 1 }
  finally { engine.dispose(); rmSync(dir, { recursive: true, force: true }); app.exit(code) }
})
