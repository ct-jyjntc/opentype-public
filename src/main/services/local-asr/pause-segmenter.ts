const SAMPLE_RATE = 16000
const FRAME = SAMPLE_RATE * .02
const MAX_SAMPLES = SAMPLE_RATE * 25
const MIN_SAMPLES = SAMPLE_RATE * 2
const PAUSE_SAMPLES = SAMPLE_RATE * .7
const QUIET_RMS = .006

/** Conservative energy-based pause detection, not a speech filter: never drops samples. */
export class PauseSegmenter {
  private buffer = new Float32Array(MAX_SAMPLES)
  private length = 0
  private frameEnergy = 0
  private frameSamples = 0
  private quietSamples = 0
  private heardSound = false
  private bestEnergy = Infinity
  private bestCut = MAX_SAMPLES

  constructor(private readonly emit: (samples: Float32Array) => void) {}

  push(samples: Float32Array) {
    for (const sample of samples) {
      this.buffer[this.length++] = sample
      this.frameEnergy += sample * sample
      if (++this.frameSamples < FRAME) continue
      const energy = this.frameEnergy / FRAME
      if (energy < QUIET_RMS * QUIET_RMS) this.quietSamples += FRAME
      else { this.quietSamples = 0; this.heardSound = true }
      // If speech never pauses, use the quietest boundary in the last five seconds.
      if (this.length >= SAMPLE_RATE * 20 && energy <= this.bestEnergy) {
        this.bestEnergy = energy
        this.bestCut = this.length - FRAME / 2
      }
      this.frameEnergy = 0
      this.frameSamples = 0
      if (this.heardSound && this.length >= MIN_SAMPLES && this.quietSamples >= PAUSE_SAMPLES)
        this.cut(this.length)
      else if (this.length === MAX_SAMPLES) this.cut(this.bestCut)
    }
  }

  private cut(end: number) {
    const segment = this.buffer.slice(0, end)
    const remaining = this.buffer.slice(end, this.length)
    this.reset()
    this.emit(segment)
    // Re-evaluate the retained tail so frame boundaries do not depend on IPC chunk sizes.
    this.push(remaining)
  }

  flush() {
    if (this.length) this.cut(this.length)
  }

  private reset() {
    this.length = this.frameSamples = this.quietSamples = this.frameEnergy = 0
    this.heardSound = false
    this.bestEnergy = Infinity
    this.bestCut = MAX_SAMPLES
  }

  dispose() {
    this.reset()
    this.buffer = new Float32Array(0)
  }
}
