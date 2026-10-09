import { app, utilityProcess } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, cpus, totalmem } from 'node:os'
import { CaptureSession } from '../src/main/services/capture-session'
import { LocalAsrProcess } from '../src/main/services/local-asr/process'
import { NativeLocalProvider } from '../src/main/services/providers/native-local'
import { decodeLocalAudio } from '../src/main/services/local-asr/audio-decode'
import { encodeWav } from '../src/main/services/pcm'
import type { SpeechProvider } from '../src/main/services/providers/types'

const dir = mkdtempSync(join(tmpdir(), 'opentype-live-asr-'))
app.setName('OpenType live ASR test'); app.setPath('userData', dir)
app.whenReady().then(async () => {
  let code = 0
  const engine = new LocalAsrProcess(() => {
    const child = utilityProcess.fork(resolve('dist/main/sensevoice-worker.js'), [], { serviceName: 'OpenType live ASR test', stdio: 'pipe' })
    child.stderr?.on('data', data => process.stderr.write(data))
    return child
  }, resolve('gateway/models/sensevoice-int8'))
  try {
    const sentences = [
      '明天下午三点开会，讨论下个季度的产品路线图。',
      '请先完成快捷键设置，然后检查录音和文字输入。',
      '这次测试需要保留完整内容，不能漏掉最后一句话。',
    ]
    const samples: Float32Array[] = []
    for (let i = 0; i < sentences.length; i++) {
      const aiff = join(dir, `${i}.aiff`), wav = join(dir, `${i}.wav`)
      execFileSync('say', ['-v', 'Tingting', '-r', '175', '-o', aiff, sentences[i]], { stdio: 'ignore' })
      execFileSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', wav], { stdio: 'ignore' })
      samples.push((await decodeLocalAudio(readFileSync(wav))).samples)
    }
    const parts: Float32Array[] = []
    for (let i = 0; i < 6; i++) {
      parts.push(samples[i % samples.length])
      if (i !== 5) parts.push(new Float32Array(16000))
    }
    const audio = encodeWav(parts, 16000), source = (await decodeLocalAudio(audio)).samples
    const jobs: Array<{ seconds: number; elapsedMs: number; finishedAt: number; error?: string; rssMiB?: number }> = []
    const provider = new NativeLocalProvider({ transcribe: async (bytes, signal) => {
      const started = performance.now()
      const result = await engine.transcribe(bytes, signal)
      jobs.push({ seconds: (bytes.length - 44) / 32000, elapsedMs: performance.now() - started,
        finishedAt: performance.now(), error: result.error, rssMiB: (result as { rssMiB?: number }).rssMiB })
      return result
    } }, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'test', enabled: false })
    const run = async (speechProvider: SpeechProvider, realtime: boolean) => {
      const inserted: string[] = []
      let saved: Uint8Array | undefined
      const session = new CaptureSession({
        provider: speechProvider,
        getConfig: () => ({ mode: 'voice_transcript', outputLanguage: 'en', asrLanguage: 'zh', autoInject: true, blacklistDomains: [], appVersion: 'test' }),
        context: () => ({ appName: 'test', bundleId: '', audioContext: {}, selectedText: '' }),
        notify: () => {}, flush: async () => {},
        saveAudio: async (_id, bytes) => { saved = bytes; writeFileSync(join(dir, 'recording.wav'), bytes); return join(dir, 'recording.wav') },
        saveHistory: async () => {}, loadHistory: async () => null,
        inject: async text => { inserted.push(text) }, showCard: () => {}, changed: () => {}, personalization: async () => ({}),
      })
      const id = (await session.onStart())!.audioId
      const feedStarted = performance.now(), jobStart = jobs.length
      try {
        for (let at = 0; at < source.length; at += 1024) {
          const end = Math.min(at + 1024, source.length)
          if (realtime) {
            const delay = feedStarted + end / 16 - performance.now()
            if (delay > 0) await new Promise(r => setTimeout(r, delay))
          }
          session.pushAudio(source.subarray(at, end), 16000, 0, id)
        }
        const stoppedAt = performance.now()
        const completedBeforeStop = jobs.length - jobStart
        assert.equal(inserted.length, 0)
        const result = await session.onStop()
        const stopToTextMs = performance.now() - stoppedAt
        assert(result?.success, JSON.stringify(result))
        assert.equal(inserted.length, 1)
        assert.deepEqual(saved, encodeWav([source], 16000))
        for (const phrase of ['明天下午3点开会', '快捷键设置', '最后一句话'])
          assert.equal(result.text!.split(phrase).length - 1, 2, result.text)
        const ownJobs = jobs.slice(jobStart)
        assert(ownJobs.every(job => !job.error))
        if (realtime) assert(completedBeforeStop >= 4, 'Earlier sentences must finish during recording')
        return { stopToTextMs, completedBeforeStop, totalJobs: ownJobs.length, jobs: ownJobs,
          rawText: result.rawText, text: result.text }
      } finally { session.dispose() }
    }
    console.log(`Feeding ${(source.length / 16000).toFixed(1)} seconds of synthetic Chinese speech in real time, with cold model startup.`)
    const live = await run(provider, true)
    console.log('OK incremental capture:', JSON.stringify(live))
    // The baseline gets an already-warm model; live capture above includes cold startup.
    const baseline = await run({ name: provider.name, transcribe: p => provider.transcribe(p) }, false)
    console.log('OK whole-recording baseline:', JSON.stringify(baseline))
    const report = { recordedAt: new Date().toISOString(), input: 'macOS Tingting synthetic speech; paced PCM, not a microphone test',
      audioSeconds: source.length / 16000, cpu: cpus()[0]?.model, systemMemoryGiB: totalmem() / 2 ** 30,
      refinementEnabled: false, live, baseline,
      stopWaitReductionPercent: (1 - live.stopToTextMs / baseline.stopToTextMs) * 100 }
    const output = resolve('tmp/live-transcription'); mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n')
    console.log('BENCHMARK', JSON.stringify({ audioSeconds: report.audioSeconds, liveMs: live.stopToTextMs,
      baselineMs: baseline.stopToTextMs, reductionPercent: report.stopWaitReductionPercent }))
  } catch (error) { console.error(error); code = 1 }
  finally { engine.dispose(); rmSync(dir, { recursive: true, force: true }); app.exit(code) }
})
