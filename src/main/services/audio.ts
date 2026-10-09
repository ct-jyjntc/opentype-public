import koffi from 'koffi'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { encodeWav } from './pcm'

// 复用纯 DSP 层：编码器只负责「怎么压」，PCM 格式转换与 WAV 封装在 pcm.ts 里单测覆盖。
export { encodeWav, float32ToInt16, computeRms } from './pcm'

const OPUS_BITRATE = 32_000
const OPUS_FRAME_SIZE_MS = 20
const OPUS_COMPLEXITY = 10

export interface EncodeResult {
  data: Uint8Array
  format: 'ogg' | 'wav'
  sampleRate: number
  durationSeconds: number
}

/**
 * Opus 编码器封装。libopusenc 存在时走原生编码，否则返回 null 由上层回退 WAV。
 */
class OpusEncoder {
  private lib: koffi.IKoffiLib | null = null
  private convertFn: koffi.KoffiFunction | null = null
  private initialized = false

  private init(searchPaths: string[]): void {
    if (this.initialized) return
    this.initialized = true

    const found = searchPaths.find((p) => existsSync(p))
    if (!found) return

    try {
      this.lib = koffi.load(found)
      // opus_convert_advanced(input, output, sample_rate, bitrate_kbps, channels, frame_size_ms,
      //                       out_duration, out_output_size, out_error_code, out_actual_bitrate)
      this.convertFn = this.lib.func('opus_convert_advanced', 'int', [
        'str', 'str', 'int', 'float', 'int', 'int',
        koffi.out(koffi.pointer('double')),
        koffi.out(koffi.pointer('uint64')),
        koffi.out(koffi.pointer('int')),
        koffi.out(koffi.pointer('float'))
      ])
    } catch {
      this.lib = null
      this.convertFn = null
    }
  }

  /** 用临时文件交换数据：libopusenc 的接口是文件路径式，比内存指针更稳。 */
  encode(chunks: Float32Array[], sampleRate: number, searchPaths: string[]): Uint8Array | null {
    this.init(searchPaths)
    if (!this.convertFn) return null

    const wav = encodeWav(chunks, sampleRate)
    const dir = join(tmpdir(), 'opentype-opus')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const wavPath = join(dir, `${randomUUID()}.wav`)
    const oggPath = join(dir, `${randomUUID()}.ogg`)

    try {
      writeFileSync(wavPath, wav)
      const outDuration = [0]
      const outSize = [0n]
      const outError = [0]
      const outBitrate = [0]

      const rc = this.convertFn(
        wavPath, oggPath, sampleRate, OPUS_BITRATE / 1000, 1, OPUS_FRAME_SIZE_MS,
        outDuration, outSize, outError, outBitrate
      )
      if (rc !== 0 || !existsSync(oggPath)) return null
      return new Uint8Array(readFileSync(oggPath))
    } catch {
      return null
    } finally {
      for (const p of [wavPath, oggPath]) {
        try { if (existsSync(p)) unlinkSync(p) } catch { /* 清理失败不影响主流程 */ }
      }
    }
  }
}

const opus = new OpusEncoder()

export class AudioEncoder {
  constructor(private readonly opusLibPaths: string[] = []) {}

  async encode(chunks: Float32Array[], sampleRate: number): Promise<EncodeResult> {
    const durationSeconds = chunks.reduce((n, c) => n + c.length, 0) / sampleRate

    const encoded = opus.encode(chunks, sampleRate, this.opusLibPaths)
    if (encoded) {
      return { data: encoded, format: 'ogg', sampleRate, durationSeconds }
    }

    // 回退：WAV 体积约为 Opus 的 12 倍，但保证链路可用
    const wav = encodeWav(chunks, sampleRate)
    return { data: wav, format: 'wav', sampleRate, durationSeconds }
  }
}

export const OPUS_CONFIG = {
  bitrate: OPUS_BITRATE,
  frameSizeMs: OPUS_FRAME_SIZE_MS,
  complexity: OPUS_COMPLEXITY
}
