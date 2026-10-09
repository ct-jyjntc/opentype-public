// AudioWorklet 采集处理器。
//
// 音频工作线程实现。
// 相比 ScriptProcessorNode 的优势：
// - 运行在独立音频线程，不受主线程 GC/长任务影响，不会丢帧
// - 1024 样本/消息（16kHz 下约 64ms），粒度比 ScriptProcessor 的 4096 帧更细
// - 用 transferable 移交 buffer，主线程零拷贝接收
//
// 注意：本文件在 AudioWorklet 线程执行，不能 import 任何主线程模块，
// 也不能访问 window / document / ipcRenderer。

/** 每条消息携带的样本数。16kHz 下约 64ms。 */
const SAMPLES_PER_MESSAGE = 1024

/** 处理器注册名，主线程通过此名创建 AudioWorkletNode。 */
export const PROCESSOR_NAME = 'opentype-audio-capture'

// AudioWorkletGlobalScope 的全局类型。TS 的 DOM lib 只覆盖主线程全局对象，
// 这里内联声明（而非放 .d.ts）以保证无论 tsconfig 如何配置都能编译。
declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: unknown): boolean
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor
): void

class OpenTypeAudioCaptureProcessor extends AudioWorkletProcessor {
  private recording: boolean
  private pendingSamples: Float32Array
  private pendingSampleCount: number
  private dataMessage: { type: string; samples: Float32Array | null }

  constructor() {
    super()
    this.recording = false
    this.pendingSamples = new Float32Array(SAMPLES_PER_MESSAGE)
    this.pendingSampleCount = 0
    this.dataMessage = { type: 'recording:data', samples: null }

    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message?.type === 'recording:start') {
        this.startRecording()
        return
      }
      if (message?.type === 'recording:stop') {
        this.recording = false
        this.flushPendingSamples()
        this.port.postMessage({ type: 'recording:stopped' })
        this.pendingSampleCount = 0
      }
    }
  }

  startRecording() {
    this.pendingSampleCount = 0
    this.recording = true
  }

  /** 把缓冲区内剩余样本发出。停录时必须调用，否则尾部数据会丢。 */
  flushPendingSamples() {
    if (this.pendingSampleCount === 0) return

    const samples = new Float32Array(this.pendingSampleCount)
    for (let i = 0; i < this.pendingSampleCount; i += 1) {
      samples[i] = this.pendingSamples[i]
    }
    this.pendingSampleCount = 0

    this.dataMessage.samples = samples
    // 第二个参数是 transferable 列表：移交 buffer 所有权，主线程零拷贝接收。
    // 若用普通 postMessage，每 64ms 都会产生一次结构化克隆的内存拷贝。
    this.port.postMessage(this.dataMessage, [samples.buffer])
    this.dataMessage.samples = null
  }

  appendSamples(channel: Float32Array): void {
    let readOffset = 0
    while (readOffset < channel.length) {
      const availableSpace = SAMPLES_PER_MESSAGE - this.pendingSampleCount
      const samplesToCopy = Math.min(availableSpace, channel.length - readOffset)
      for (let i = 0; i < samplesToCopy; i += 1) {
        this.pendingSamples[this.pendingSampleCount + i] = channel[readOffset + i]
      }
      this.pendingSampleCount += samplesToCopy
      readOffset += samplesToCopy
      if (this.pendingSampleCount === SAMPLES_PER_MESSAGE) this.flushPendingSamples()
    }
  }

  /** 多声道取算术平均混音，而非只取首声道。 */
  appendInputChannels(channels: Float32Array[]): void {
    if (channels.length === 1) {
      this.appendSamples(channels[0])
      return
    }

    const frameCount = channels[0]?.length || 0
    let readOffset = 0
    while (readOffset < frameCount) {
      const availableSpace = SAMPLES_PER_MESSAGE - this.pendingSampleCount
      const samplesToCopy = Math.min(availableSpace, frameCount - readOffset)
      for (let i = 0; i < samplesToCopy; i += 1) {
        let sampleSum = 0
        for (const channel of channels) sampleSum += channel[readOffset + i]
        this.pendingSamples[this.pendingSampleCount + i] = sampleSum / channels.length
      }
      this.pendingSampleCount += samplesToCopy
      readOffset += samplesToCopy
      if (this.pendingSampleCount === SAMPLES_PER_MESSAGE) this.flushPendingSamples()
    }
  }

  /** 音频线程回调。未录音时立即返回，不产生任何开销。 */
  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true

    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true

    this.appendInputChannels(input)
    return true
  }
}

registerProcessor(PROCESSOR_NAME, OpenTypeAudioCaptureProcessor)
