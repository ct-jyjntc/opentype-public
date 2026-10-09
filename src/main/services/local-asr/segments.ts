/** Internal inference windows, not a recording limit. Every sample belongs to one segment. */
export function* audioSegments(samples: Float32Array, sampleRate: number): Generator<Float32Array> {
  const window = Math.round(25 * sampleRate)
  let start = 0
  while (start < samples.length) {
    let end = Math.min(start + window, samples.length)
    if (end < samples.length) {
      // Prefer a quiet boundary in the last five seconds to avoid cutting words.
      const frame = Math.max(1, Math.round(sampleRate * .04))
      let best = Infinity
      const stop = end
      for (let at = stop - Math.round(5 * sampleRate); at + frame <= stop; at += frame) {
        let energy = 0
        for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i]
        if (energy <= best) { best = energy; end = at + Math.floor(frame / 2) }
      }
    }
    yield samples.subarray(start, end)
    start = end
  }
}
export function joinTranscripts(parts: string[]): string {
  return parts.filter(Boolean).reduce((text, part) => {
    if (!text) return part
    const needsSpace = /[A-Za-z0-9.!?,;:]$/.test(text) && /^[A-Za-z0-9]/.test(part)
    return text + (needsSpace ? ' ' : '') + part
  }, '')
}
