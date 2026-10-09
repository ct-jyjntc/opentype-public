// 纯 PCM 处理。刻意不依赖任何原生库或 Electron：
// 这一层是可单测的数学逻辑，与「编码器是否可用」解耦。

/** Float32 [-1,1] -> Int16 PCM。削波保护必须做：蓝牙麦克风偶发超幅，不夹紧会环绕成反相爆音。 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** 多块 Float32 顺序拼接并转 Int16，顺序错了音频会断裂。 */
export function concatToInt16(chunks: Float32Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(float32ToInt16(chunk), offset)
    offset += chunk.length
  }
  return out
}

/** 生成 44 字节标准 WAV 头 + PCM 数据。 */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const pcm = concatToInt16(chunks)
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(pos + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)              // fmt 块长度
  view.setUint16(20, 1, true)               // PCM 格式
  view.setUint16(22, 1, true)               // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)  // 字节率 = 采样率 * 块对齐
  view.setUint16(32, 2, true)               // 块对齐 = 声道 * 位深/8
  view.setUint16(34, 16, true)              // 位深
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)

  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes))
  return new Uint8Array(buffer)
}

/** RMS 音量，驱动浮窗波形。 */
export function computeRms(pcm: Float32Array): number {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}
