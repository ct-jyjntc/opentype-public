import { encodeWav } from '../pcm'
import { PauseSegmenter } from './pause-segmenter'
import { joinTranscripts } from './segments'

type Segment = { samples?: Float32Array; text?: string; error?: string; tail?: boolean; length: number }
/** A sub-second remainder flushed at stop is usually breath or key noise that providers reject. */
const DROPPABLE_TAIL_SAMPLES = 16000
/**
 * Only "no usable speech" outcomes may drop that tail: SiliconFlow 400/413/422 rejection,
 * undecodable/empty segment audio (audio-decode, SenseVoice worker). Rate-limit, balance,
 * network, timeout and crash errors still fail the recording so the last word is never lost.
 */
const NO_SPEECH_ERRORS = new Set(['siliconflow_audio_rejected', 'invalid_audio', 'empty_audio', 'empty_transcription'])
export interface SegmentRecognizer {
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text?: string; error?: string }>
}

/** Serial speculative ASR during capture. Only finish exposes the complete transcript. */
export class LiveLocalTranscription {
  private segments: Segment[] = []
  private work = Promise.resolve()
  private segmenter = new PauseSegmenter(samples => this.enqueue(samples))
  private sealed = false
  private flushing = false
  private disposed = false
  private controller = new AbortController()
  private result?: Promise<{ text?: string; error?: string }>
  private readonly abort = () => this.dispose()

  constructor(private readonly engine: SegmentRecognizer,
    private readonly signal: AbortSignal,
    private readonly onStableText?: (text: string, segments: number) => void,
    private readonly failureDetail = 'local_asr_failed',
    private readonly shouldRetry: (error: string) => boolean = () => true) {
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.dispose()
  }

  pushAudio(samples: Float32Array) {
    if (!this.sealed && !this.disposed) this.segmenter.push(samples)
  }

  private enqueue(samples: Float32Array) {
    const segment: Segment = { samples, length: samples.length, tail: this.flushing }
    this.segments.push(segment)
    this.work = this.work.then(() => this.recognize(segment))
  }

  private async recognize(segment: Segment) {
    if (this.disposed || this.signal.aborted || !segment.samples) return
    try {
      const result = await this.engine.transcribe(encodeWav([segment.samples], 16000), this.controller.signal)
      if (this.disposed || this.signal.aborted) return
      segment.error = result.error ?? (typeof result.text === 'string' ? undefined : this.failureDetail)
      if (!segment.error) {
        segment.text = result.text?.trim() ?? ''
        segment.samples = undefined
        // Publish only the contiguous successful prefix; never hide a failed gap.
        const prefix: string[] = []
        for (const item of this.segments) {
          if (item.error || item.text === undefined) break
          prefix.push(item.text)
        }
        this.onStableText?.(joinTranscripts(prefix).slice(-600), prefix.length)
      }
    } catch {
      if (!this.disposed) segment.error = this.failureDetail
    }
  }

  finish() {
    return this.result ??= this.complete()
  }

  seal() {
    if (this.sealed || this.disposed) return
    this.sealed = true
    this.flushing = true
    try { this.segmenter.flush() } finally { this.flushing = false }
  }

  private async complete(): Promise<{ text?: string; error?: string }> {
    this.seal()
    if (this.disposed || this.signal.aborted) return { error: 'cancelled' }
    await this.work
    if (this.disposed || this.signal.aborted) return { error: 'cancelled' }
    // A crashed/busy background job must not silently remove a sentence. Retry only
    // failed audio once; successful segments are never re-transcribed or duplicated.
    for (const segment of this.segments) {
      if (segment.error && this.shouldRetry(segment.error)) await this.recognize(segment)
      if (this.disposed || this.signal.aborted) return { error: 'cancelled' }
      if (segment.error && this.droppableTail(segment)) { segment.error = undefined; segment.text = ''; continue }
      if (segment.error) return { error: segment.error }
    }
    return { text: joinTranscripts(this.segments.map(segment => segment.text ?? '')) }
  }

  /** Only the final sub-second stop remainder may fail quietly, and only when earlier speech was recognized. */
  private droppableTail(segment: Segment) {
    return segment.tail === true && segment === this.segments[this.segments.length - 1]
      && !!segment.error && NO_SPEECH_ERRORS.has(segment.error)
      && segment.length < DROPPABLE_TAIL_SAMPLES
      && this.segments.some(item => item !== segment && !!item.text)
  }

  dispose() {
    this.disposed = true
    this.controller.abort()
    this.segmenter.dispose()
    // Queued closures may still exist until the in-flight job settles.
    for (const segment of this.segments) segment.samples = undefined
    this.segments = []
    this.signal.removeEventListener('abort', this.abort)
  }
}
