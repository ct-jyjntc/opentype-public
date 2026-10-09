/** Short local feedback tones; independent of the microphone's silent output sink. */
export class RecordingCues {
  private context?: AudioContext
  private nodes = new Set<OscillatorNode>()
  async play(kind: 'start' | 'stop' | 'cancel') {
    try {
      const context = this.context ??= new AudioContext()
      if (context.state === 'suspended') await context.resume()
      if (context.state === 'closed') return
      const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(kind === 'start' ? 620 : kind === 'stop' ? 780 : 400, now)
      oscillator.frequency.linearRampToValueAtTime(kind === 'start' ? 880 : kind === 'stop' ? 580 : 280, now + .09)
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.035, now + .008)
      gain.gain.exponentialRampToValueAtTime(.0001, now + .11)
      oscillator.connect(gain); gain.connect(context.destination)
      this.nodes.add(oscillator)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.nodes.delete(oscillator) }
      oscillator.start(now); oscillator.stop(now + .12)
    } catch { /* Missing output permission/device must never prevent recording. */ }
  }
  async dispose() {
    for (const node of this.nodes) { try { node.stop() } catch {} }
    this.nodes.clear()
    await this.context?.close().catch(()=>{})
    this.context = undefined
  }
}
