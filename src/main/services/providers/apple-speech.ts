import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeLocalAudio } from '../local-asr/audio-decode'
import { audioSegments, joinTranscripts } from '../local-asr/segments'
import { LiveLocalTranscription } from '../local-asr/live-transcription'
import { encodeWav } from '../pcm'
import { refineTranscript, type RefinementConfig } from './refinement'
import type { SpeechProvider, TranscribeParams, TranscribeResult } from './types'

export interface AppleSpeechStatus {
  available: boolean
  installed: boolean
  engine?: 'SpeechAnalyzer' | 'SFSpeechRecognizer'
  locale?: string
  supportedLocales?: string[]
  permission?: number
  error?: string
}
export interface AppleSpeechEngine {
  transcribe(audio: Uint8Array, language: string, signal?: AbortSignal): Promise<{ text?: string; error?: string }>
}

/** No Apple cloud requests: the helper refuses recognition without on-device support. */
export class AppleSpeechProcess implements AppleSpeechEngine {
  private children = new Set<ChildProcess>()
  private installing = false
  private installController?: AbortController
  constructor(private readonly executable: string, private readonly platform = process.platform) {}

  private run(operation: 'status' | 'install' | 'transcribe', language: string, path?: string, signal?: AbortSignal): Promise<Record<string, any>> {
    if (signal?.aborted) return Promise.resolve({ error: 'cancelled' })
    if (this.platform !== 'darwin') return Promise.resolve({ error: 'apple_speech_platform' })
    return new Promise(resolve => {
      const child = spawn(this.executable, [operation, language, ...(path ? [path] : [])], { stdio: ['ignore', 'pipe', 'ignore'] })
      this.children.add(child)
      let output = '', error: string | undefined
      const abort = () => { error = 'cancelled'; child.kill() }
      const timeout = setTimeout(() => { error = 'apple_speech_timeout'; child.kill() }, operation === 'install' ? 900_000 : operation === 'status' ? 15_000 : 90_000)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout!.on('data', data => {
        output += data.toString()
        if (output.length > 1_000_000) { error = 'apple_speech_failed'; child.kill() }
      })
      child.on('error', () => { error ??= 'apple_speech_unavailable' })
      child.on('close', code => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        this.children.delete(child)
        if (error) return resolve({ error })
        if (code !== 0) return resolve({ error: 'apple_speech_unavailable' })
        try { resolve(JSON.parse(output.trim())) }
        catch { resolve({ error: 'apple_speech_failed' }) }
      })
    })
  }

  async status(language = 'auto'): Promise<AppleSpeechStatus> {
    const result = await this.run('status', language)
    return { available: false, installed: false, ...result }
  }
  async install(language = 'auto'): Promise<AppleSpeechStatus> {
    if (this.installing) return { available: false, installed: false, error: 'apple_speech_busy' }
    this.installing = true
    this.installController = new AbortController()
    try { return { available: false, installed: false, ...await this.run('install', language, undefined, this.installController.signal) } }
    finally { this.installing = false; this.installController = undefined }
  }
  async transcribe(audio: Uint8Array, language: string, signal?: AbortSignal): Promise<{ text?: string; error?: string }> {
    if (signal?.aborted) return { error: 'cancelled' }
    if (this.installing) return { error: 'apple_speech_busy' }
    if (this.platform !== 'darwin') return { error: 'apple_speech_platform' }
    let directory: string | undefined
    try {
      const { samples, sampleRate } = await decodeLocalAudio(audio)
      if (signal?.aborted) return { error: 'cancelled' }
      directory = await mkdtemp(join(tmpdir(), 'opentype-apple-speech-'))
      const path = join(directory, 'audio.wav'), texts: string[] = []
      // The older Apple API limits each task; partition audio without dropping samples.
      for (const segment of audioSegments(samples, sampleRate)) {
        if (signal?.aborted) return { error: 'cancelled' }
        await writeFile(path, encodeWav([segment], sampleRate), { mode: 0o600 })
        const result = await this.run('transcribe', language, path, signal)
        if (result.error) return { error: result.error }
        if (typeof result.text !== 'string') return { error: 'apple_speech_failed' }
        texts.push(result.text)
      }
      return { text: joinTranscripts(texts) }
    } catch { return { error: signal?.aborted ? 'cancelled' : 'apple_speech_failed' } }
    finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  }
  cancelInstall() { this.installController?.abort() }
  dispose() { this.cancelInstall(); for (const child of this.children) child.kill() }
}

export class AppleSpeechProvider implements SpeechProvider {
  readonly name = 'apple-speech'
  constructor(private readonly engine: AppleSpeechEngine, private readonly refinement: RefinementConfig,
    private readonly defaultLanguage = 'auto') {}
  private language(value: unknown) {
    if (this.defaultLanguage !== 'auto') return this.defaultLanguage
    return typeof value === 'string' && value && value !== 'auto' ? value : 'auto'
  }
  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    params.onProgress?.({ stage: 'transcribing' })
    const result = await this.engine.transcribe(params.audio, this.language(params.parameters?.language), params.signal)
    if (params.signal?.aborted) return { success: false, detail: 'cancelled' }
    if (result.error) return { success: false, detail: result.error }
    if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
    return refineTranscript(result.text, params, this.refinement)
  }
  startLiveTranscription(options: { language: string; signal: AbortSignal; onStableText?: (text: string, segments: number) => void }) {
    const language = this.language(options.language)
    const live = new LiveLocalTranscription({ transcribe: (audio, signal) => this.engine.transcribe(audio, language, signal) }, options.signal, options.onStableText)
    return {
      pushAudio: (samples: Float32Array) => live.pushAudio(samples),
      seal: () => live.seal(),
      finish: async (params: TranscribeParams): Promise<TranscribeResult> => {
        params.onProgress?.({ stage: 'transcribing' })
        const result = await live.finish()
        if (options.signal.aborted) return { success: false, detail: 'cancelled' }
        if (result.error) return { success: false, detail: result.error }
        if (!result.text?.trim()) return { success: false, detail: 'empty_transcription' }
        return refineTranscript(result.text, params, this.refinement)
      },
      dispose: () => live.dispose(),
    }
  }
}
