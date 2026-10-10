import { join } from 'node:path'
import { audioSegments, joinTranscripts } from './segments'
import { decodeLocalAudio } from './audio-decode'

type Work = { id: number; modelDir: string; audio: Uint8Array; language?: string }
/** SenseVoice language ids; anything else falls back to automatic detection. */
const SENSEVOICE_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
type Port = { on(event: 'message', fn: (event: { data: Work }) => void): void; postMessage(value: unknown): void }
const port = (process as NodeJS.Process & { parentPort?: Port }).parentPort
const send = (value: unknown) => port ? port.postMessage(value) : process.send?.(value)
// The language is fixed at recognizer creation, so keep one recognizer and rebuild
// it only when the requested language changes (live segments reuse the same one).
let recognizer: any
let recognizerLanguage = ''
let busy = false

async function run(message: Work) {
  if (busy) { send({ id: message.id, error: 'local_asr_busy' }); return }
  busy = true
  try {
    const wave = await decodeLocalAudio(new Uint8Array(message.audio))
    // Do not hallucinate text for digital silence.
    let energy = 0
    for (const sample of wave.samples) energy += sample * sample
    if (energy / wave.samples.length < 1e-10) { send({ id: message.id, text: '' }); return }
    const language = SENSEVOICE_LANGUAGES.has(String(message.language)) ? String(message.language) : 'auto'
    if (!recognizer || recognizerLanguage !== language) {
      const sherpa = require('sherpa-onnx-node')
      recognizer = undefined
      recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { senseVoice: { model: join(message.modelDir, 'model.int8.onnx'), language, useInverseTextNormalization: 1 },
          tokens: join(message.modelDir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 } })
      recognizerLanguage = language
    }
    const parts: string[] = []
    for (const samples of audioSegments(wave.samples, wave.sampleRate)) {
      let energy = 0
      for (const sample of samples) energy += sample * sample
      if (energy / samples.length >= 1e-10) {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ samples, sampleRate: wave.sampleRate })
        recognizer.decode(stream)
        const result = recognizer.getResult(stream)
        parts.push(String(result.text ?? '').replace(/<\|[^>]*\|>/g, '').trim())
      }
      // A progress heartbeat refreshes the stall watchdog, not a total-duration deadline.
      send({ id: message.id, progress: true })
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    send({ id: message.id, text: joinTranscripts(parts),
      rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20) })
  } catch (err) {
    const code = (err as Error).message
    send({ id: message.id, error: ['invalid_audio', 'unsupported_audio_format'].includes(code) ? code : 'local_asr_failed' })
  } finally { busy = false }
}

if (port) port.on('message', event => { void run(event.data) })
else process.on('message', message => { void run(message as Work) })
