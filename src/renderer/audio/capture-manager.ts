// 音频采集管理器。
//
// 音频采集管理。关键设计（对比 ScriptProcessorNode 方案）：
// - AudioWorkletNode 在独立音频线程运行，不受主线程阻塞影响
// - setSinkId({type:'none'}) 把输出路由到空设备，避免扬声器回声被麦克风拾取
// - numberOfOutputs: 0 —— 纯输入节点，不产生回放

// 从 constants 而非 worklet 导入：后者会把 worklet 代码拉进主包
import type { AudioProcessing } from '../../shared/desktop'
import { PROCESSOR_NAME } from './constants'

const TARGET_SAMPLE_RATE = 16000
const CHANNEL_COUNT = 1
/** 麦克风测试用的分析器参数。 */
const ANALYSER_FFT_SIZE = 1024
const ANALYSER_SMOOTHING = 0.8

export interface CaptureChunk {
  samples: Float32Array
  sequence: number
}

export interface CaptureOptions {
  deviceId?: string
  processing?: AudioProcessing
  onDeviceEnded?: () => void
  onChunk: (chunk: CaptureChunk) => void
  onLevel?: (rms: number) => void
  onStopped?: () => void
}

/**
 * 采集管理器。生命周期与录音会话一致：每次录音复用同一个 AudioContext 与 WorkletNode，
 * 避免反复创建导致的内存增长与设备重开延迟。
 */
export class AudioCaptureManager {
  private audioContext: AudioContext | null = null
  private workletModulePromise: Promise<void> | null = null
  private workletNode: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private sequence = 0
  private active = false
  private stopped: (() => void) | null = null

  /** worklet 模块 URL。构建工具会把 worklet.ts 单独打包。 */
  private readonly workletUrl: string

  constructor(workletUrl: string) {
    this.workletUrl = workletUrl
  }

  get isActive(): boolean {
    return this.active
  }

  get context(): AudioContext | null {
    return this.audioContext
  }

  private ensureContext(): AudioContext {
    if (this.audioContext) return this.audioContext

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    this.audioContext = ctx

    // 把输出路由到空设备。否则内建麦克风会拾取扬声器声音形成啸叫，
    // 而且录音期间用户会听到自己的声音被回放。
    if (typeof (ctx as AudioContext & { setSinkId?: (id: unknown) => Promise<void> }).setSinkId === 'function') {
      ;(ctx as AudioContext & { setSinkId: (id: unknown) => Promise<void> })
        .setSinkId({ type: 'none' })
        .catch(() => { /* 旧版浏览器不支持，忽略 */ })
    }
    return ctx
  }

  /** 加载 worklet 模块。失败时清空 promise，允许下次重试。 */
  private ensureWorkletModuleLoaded(): Promise<void> {
    if (this.workletModulePromise) return this.workletModulePromise
    const ctx = this.ensureContext()
    this.workletModulePromise = ctx.audioWorklet.addModule(this.workletUrl).catch((err) => {
      this.workletModulePromise = null
      throw err
    })
    return this.workletModulePromise
  }

  private async ensureWorkletNode(): Promise<AudioWorkletNode> {
    await this.ensureWorkletModuleLoaded()
    if (this.workletNode) return this.workletNode

    // numberOfOutputs: 0 —— 纯输入节点，不产生任何输出音频
    this.workletNode = new AudioWorkletNode(this.ensureContext(), PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0
    })
    return this.workletNode
  }

  async start(options: CaptureOptions): Promise<{ sampleRate: number; channelCount: number }> {
    if (this.active) throw new Error('capture already active')

    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: CHANNEL_COUNT,
        echoCancellation: options.processing?.echoCancellation ?? true,
        noiseSuppression: options.processing?.noiseSuppression ?? true,
        autoGainControl: options.processing?.autoGainControl ?? true,
        ...(options.deviceId && options.deviceId !== 'default'
          ? { deviceId: { exact: options.deviceId } }
          : {})
      }
    }

    this.stream = await navigator.mediaDevices.getUserMedia(constraints)
    try {
    const ctx = this.ensureContext()
    const node = await this.ensureWorkletNode()

    this.source = ctx.createMediaStreamSource(this.stream)
    this.source.connect(node)

    // 音量检测独立走 AnalyserNode，不占用采集链路
    if (options.onLevel) {
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = ANALYSER_FFT_SIZE
      this.analyser.smoothingTimeConstant = ANALYSER_SMOOTHING
      this.source.connect(this.analyser)
      this.startLevelPolling(options.onLevel)
    }

    node.port.onmessage = (event) => {
      const message = event.data
      if (message?.type === 'recording:data' && message.samples) {
        options.onChunk({ samples: message.samples as Float32Array, sequence: this.sequence++ })
      } else if (message?.type === 'recording:stopped') {
        this.stopped?.(); this.stopped = null
        options.onStopped?.()
      }
    }

    // AudioContext 可能因自动播放策略处于 suspended，需显式恢复
    if (ctx.state === 'suspended') await ctx.resume()

    node.port.postMessage({ type: 'recording:start' })
    this.active = true
    for (const track of this.stream.getAudioTracks()) track.onended = () => { if (this.active) options.onDeviceEnded?.() }
    if (this.stream.getAudioTracks().some(track=>track.readyState==='ended')) options.onDeviceEnded?.()
    this.sequence = 0

    return { sampleRate: ctx.sampleRate, channelCount: CHANNEL_COUNT }
    } catch (error) {
      this.source?.disconnect(); this.source=null; this.analyser?.disconnect(); this.analyser=null
      this.stopLevelPolling(); this.stream?.getTracks().forEach(t=>t.stop()); this.stream=null
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.stopLevelPolling()

    // Acknowledge the actual tail flush, not an arbitrary 60 ms delay.
    await new Promise<void>(resolve => {
      const timer=setTimeout(resolve,1000)
      this.stopped=()=>{clearTimeout(timer);resolve()}
      this.workletNode?.port.postMessage({type:'recording:stop'})
    })
    this.stopped=null

    this.source?.disconnect()
    this.source = null
    this.analyser?.disconnect()
    this.analyser = null
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop() })
    this.stream = null
  }

  /** 释放全部资源。仅在应用退出或切换设备时调用。 */
  async dispose(): Promise<void> {
    await this.stop()
    this.workletNode?.port.close()
    this.workletNode = null
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }
    this.audioContext = null
    this.workletModulePromise = null
  }

  // MARK: - 音量检测

  private levelTimer: number | null = null

  private startLevelPolling(onLevel: (rms: number) => void): void {
    this.stopLevelPolling()
    const buffer = new Uint8Array(ANALYSER_FFT_SIZE)
    const tick = () => {
      if (!this.analyser) return
      this.analyser.getByteTimeDomainData(buffer)
      // AnalyserNode 输出以 128 为中心的无符号字节，需先居中再算 RMS
      let sum = 0
      for (let i = 0; i < buffer.length; i += 1) {
        const centered = buffer[i] - 0x80
        sum += centered * centered
      }
      onLevel(Math.sqrt(sum / buffer.length) / 0x80)
      this.levelTimer = requestAnimationFrame(tick)
    }
    this.levelTimer = requestAnimationFrame(tick)
  }

  private stopLevelPolling(): void {
    if (this.levelTimer !== null) {
      cancelAnimationFrame(this.levelTimer)
      this.levelTimer = null
    }
  }
}

/** 枚举可用麦克风。首次调用需已有授权，否则 label 为空。 */
export async function listMicrophones(): Promise<Array<{ deviceId: string; label: string; isDefault: boolean }>> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((d) => d.kind === 'audioinput')
  const defaultId = inputs[0]?.deviceId
  return inputs.map((d) => ({
    deviceId: d.deviceId,
    label: d.label || `麦克风 ${d.deviceId.slice(0, 6)}`,
    isDefault: d.deviceId === defaultId
  }))
}

/**
 * 麦克风测试：只传 deviceId，不带任何音频约束。
 * 目的是测原始音质，与正式采集（带 echoCancellation 等）分离。
 */
export async function testMicrophone(deviceId: string, ctx: AudioContext): Promise<{ rms: number } | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId } })
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING
    source.connect(analyser)

    const buffer = new Uint8Array(ANALYSER_FFT_SIZE)
    let sum = 0
    for (let n = 0; n < 10; n += 1) {
      await new Promise((r) => setTimeout(r, 30))
      analyser.getByteTimeDomainData(buffer)
      let frameSum = 0
      for (let i = 0; i < buffer.length; i += 1) {
        const centered = buffer[i] - 0x80
        frameSum += centered * centered
      }
      sum += Math.sqrt(frameSum / buffer.length) / 0x80
    }

    stream.getTracks().forEach((t) => t.stop())
    source.disconnect()
    analyser.disconnect()
    return { rms: sum / 10 }
  } catch {
    return null
  }
}
