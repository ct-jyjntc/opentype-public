const ascii = (data: Uint8Array, offset: number, length: number) => String.fromCharCode(...data.subarray(offset, offset + length))

/** Sniff actual bytes: older recordings have WAV content with an .ogg filename. */
export async function decodeLocalAudio(audio: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (ascii(audio, 0, 4) === 'RIFF' && ascii(audio, 8, 4) === 'WAVE') {
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    let format = 0, channels = 0, sampleRate = 0, bits = 0, start = 0, size = 0
    for (let offset = 12; offset + 8 <= audio.length;) {
      const length = view.getUint32(offset + 4, true), next = offset + 8 + length
      if (next > audio.length) throw new Error('invalid_audio')
      const id = ascii(audio, offset, 4)
      if (id === 'fmt ' && length >= 16) {
        format = view.getUint16(offset + 8, true); channels = view.getUint16(offset + 10, true)
        sampleRate = view.getUint32(offset + 12, true); bits = view.getUint16(offset + 22, true)
      }
      if (id === 'data') { start = offset + 8; size = length }
      offset = next + (length % 2)
    }
    if (!start || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000
      || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new Error('unsupported_audio_format')
    const bytes = bits / 8, frames = size / (bytes * channels)
    if (!Number.isInteger(frames) || !frames) throw new Error('invalid_audio')
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
      const offset = start + (i * channels + c) * bytes
      const value = format === 1 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true)
      if (!Number.isFinite(value)) throw new Error('invalid_audio')
      samples[i] += Math.max(-1, Math.min(1, value)) / channels
    }
    return { samples, sampleRate }
  }
  if (ascii(audio, 0, 4) !== 'OggS') throw new Error('unsupported_audio_format')
  const { OggOpusDecoder } = await import('ogg-opus-decoder')
  const decoder = new OggOpusDecoder()
  await decoder.ready
  const chunks: Float32Array[] = []
  let total = 0
  const append = (value: Awaited<ReturnType<typeof decoder.flush>>) => {
    if (value.errors.length) throw new Error('invalid_audio')
    total += value.samplesDecoded
    if (!value.samplesDecoded) return
    if (!value.channelData.length || value.channelData.length > 2) throw new Error('unsupported_audio_format')
    const mono = new Float32Array(value.samplesDecoded)
    for (const channel of value.channelData) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / value.channelData.length
    chunks.push(mono)
  }
  try {
    // Decode incrementally without rejecting recordings based on elapsed time.
    for (let i = 0; i < audio.length; i += 16384) append(await decoder.decode(audio.subarray(i, i + 16384)))
    append(await decoder.flush())
    if (!total) throw new Error('invalid_audio')
    const samples = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
    return { samples, sampleRate: 48000 }
  } finally { decoder.free() }
}
