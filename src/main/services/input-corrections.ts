import type { CaptureTarget } from './capture-session'

export interface InputObservationNative {
  begin(token: string, text: string): { ok?: boolean }
  read(token: string): { active?: boolean; text?: string; reason?: string }
  release(token: string): void
}
interface Observation { token: string; id: string; original: string; target: CaptureTarget; started: number; latest: string; saved: string; changedAt: number }
interface Deps {
  native: InputObservationNative
  enabled: () => boolean
  allowed: (id: string, text: string, target: CaptureTarget) => boolean
  save: (id: string, original: string, corrected: string, target: CaptureTarget) => boolean
  now?: () => number
  schedule?: (fn: () => void) => () => void
}

/** One short-lived observation of a verified insertion. Native code checks the
 * exact field and unchanged surrounding text; only the inserted text crosses FFI.
 * No key logging, background-app polling, automatic dictionary writes or sync. */
export class InputCorrections {
  private current?: Observation
  private cancelTimer?: () => void
  constructor(private deps: Deps) {}
  private now() { return this.deps.now?.() ?? Date.now() }
  start(id: string, original: string, target: CaptureTarget): boolean {
    this.stop()
    if (!target.inputToken || !original || original.length > 100_000 || target.audioContext.redacted || !this.deps.enabled()) return false
    try {
      if (!this.deps.allowed(id, original, target) || !this.deps.native.begin(target.inputToken, original).ok) return false
      const now = this.now()
      this.current = { token: target.inputToken, id, original, target, started: now, latest: original, saved: original, changedAt: now }
      const tick = () => this.poll()
      this.cancelTimer = this.deps.schedule ? this.deps.schedule(tick) : (() => {
        const timer = setInterval(tick, 250); timer.unref(); return () => clearInterval(timer)
      })()
      return true
    } catch {
      // Until true is returned the capture session still owns the native token.
      this.current = undefined; this.cancelTimer?.(); this.cancelTimer = undefined
      return false
    }
  }
  poll() {
    const s = this.current
    if (!s) return
    try {
      const now = this.now()
      if (now - s.started >= 60_000 || !this.deps.enabled() || !this.deps.allowed(s.id, s.original, s.target)) { this.stop(); return }
      const value = this.deps.native.read(s.token)
      if (!value.active || typeof value.text !== 'string' || value.text.length > 100_000) { this.stop(); return }
      if (value.text !== s.latest) {
        // Remove a superseded, still-pending proposal immediately, including
        // undo. Accepted dictionary terms remain under explicit user control.
        if (s.saved !== s.original) {
          if (!this.deps.save(s.id, s.original, s.original, s.target)) { this.stop(); return }
          s.saved = s.original
        }
        s.latest = value.text; s.changedAt = now; return
      }
      if (s.latest !== s.saved && now - s.changedAt >= 1500) {
        if (!this.deps.save(s.id, s.original, s.latest, s.target)) { this.stop(); return }
        s.saved = s.latest
      }
    } catch { this.stop() }
  }
  stop() {
    const s = this.current
    this.current = undefined
    this.cancelTimer?.(); this.cancelTimer = undefined
    if (s) this.deps.native.release(s.token)
  }
}
