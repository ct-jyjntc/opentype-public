import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { OutputAudioStatus } from '../../shared/output-audio'

type LeaseMode = 'duck' | 'mute' | 'recover'
interface LeaseProcess {
  id: string
  mode: LeaseMode
  process: ChildProcess
  closed: Promise<void>
  exiting: boolean
  finished: boolean
  forced: boolean
  ready: boolean
  detail?: string
  timers: ReturnType<typeof setTimeout>[]
}
const notices = new Set(['', 'output_audio_unavailable', 'output_audio_changed',
  'output_audio_restore_pending', 'output_audio_storage_error', 'output_audio_busy'])
const failureNotices = new Set(['output_audio_unavailable', 'output_audio_storage_error', 'output_audio_busy'])

/** Native processes own output changes and restore them on stdin EOF, including a parent crash. */
export class OutputAudioControl {
  private active?: LeaseProcess
  private wanted?: string
  private serial: Promise<void> = Promise.resolve()
  private disposed = false
  private recoveryQueued = false
  private recovery: ReturnType<typeof setInterval>
  private journal = process.platform === 'win32'
    ? join(app.getPath('appData'), 'dev.opentype.output', 'lease.bin')
    : join(app.getPath('userData'), 'output-audio-lease.json')
  private state: Omit<OutputAudioStatus, 'recording'> = {
    supported: process.platform === 'darwin' || process.platform === 'win32',
    phase: 'idle', mode: 'off',
  }
  private published = ''

  constructor(
    private notice: (id: string, detail: string) => void,
    private changed: (status: OutputAudioStatus) => void = () => {},
  ) {
    this.recovery = setInterval(() => { void this.recover() }, 5000)
    this.recovery.unref()
    void this.recover()
  }

  snapshot(): OutputAudioStatus { return { ...this.state, recording: this.wanted !== undefined } }

  private update(patch: Partial<typeof this.state> = {}) {
    this.state = { ...this.state, ...patch }
    const status = this.snapshot(), signature = JSON.stringify(status)
    if (this.disposed || signature === this.published) return
    this.published = signature
    // A window closing must not interrupt the native restoration lifecycle.
    try { this.changed(status) } catch {}
  }

  private executable() {
    const relative = process.platform === 'win32' ? 'windows/build/OutputAudio.exe' : 'output-audio/build/OutputAudio'
    return app.isPackaged ? join(process.resourcesPath, 'lib', relative)
      : join(app.getAppPath(), 'native', relative)
  }

  private report(lease: LeaseProcess, detail: string) {
    if (this.active !== lease || this.disposed || (this.wanted !== undefined && this.wanted !== lease.id)) return
    try { this.notice(lease.id, detail) } catch {}
  }

  private launch(mode: LeaseMode, id: string) {
    const child = spawn(this.executable(), process.platform === 'win32' ? [mode] : [mode, this.journal], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    })
    let resolveClosed!: () => void
    const lease: LeaseProcess = {
      id, mode, process: child, closed: new Promise<void>(resolve => { resolveClosed = resolve }),
      exiting: false, finished: false, forced: false, ready: false, timers: [],
    }
    this.active = lease
    this.update({ phase: mode === 'recover' ? 'restoring' : 'starting', mode: mode === 'recover' ? 'off' : mode, detail: undefined })
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => {
      if (lease.finished || this.active !== lease) return
      buffer += data
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      if (buffer.length > 4096) buffer = ''
      for (const line of lines) {
        if (line.length > 4096) continue
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || !('notice' in value)
            || typeof value.notice !== 'string' || !notices.has(value.notice)) continue
          lease.ready = true
          // Preserve a concrete failure through an empty shutdown acknowledgement.
          if (!(lease.exiting && !value.notice && failureNotices.has(lease.detail ?? ''))) lease.detail = value.notice || undefined
          const detail = lease.detail
          this.update({
            phase: lease.exiting || mode === 'recover' ? 'restoring'
              : failureNotices.has(detail ?? '') ? 'error'
                : detail === 'output_audio_restore_pending' ? 'pending' : 'active',
            detail,
          })
          this.report(lease, detail ?? '')
        } catch {}
      }
    })
    const finish = (code: number | null, signal: NodeJS.Signals | null, failed = false) => {
      if (lease.finished) return
      lease.finished = true
      for (const timer of lease.timers) clearTimeout(timer)
      if (this.active === lease) {
        const residual = existsSync(this.journal)
        const unexpected = failed || !!code || !!signal || lease.forced || (!lease.exiting && mode !== 'recover')
        const specific = failureNotices.has(lease.detail ?? '') ? lease.detail : undefined
        const detail = specific ?? (code === 3 ? 'output_audio_busy' : undefined)
          ?? (residual ? 'output_audio_restore_pending' : unexpected ? 'output_audio_unavailable' : undefined)
        this.update({ phase: specific || (unexpected && !residual) ? 'error' : residual ? 'pending' : 'idle', mode: 'off', detail })
        this.report(lease, detail ?? '')
        this.active = undefined
      }
      resolveClosed()
    }
    // spawn errors are followed by close; either event may settle this lease only once.
    child.on('error', () => {
      if (!child.pid) { finish(null, null, true); return }
      if (lease.finished) return
      // A failed kill also emits error. It does not mean the process exited.
      lease.detail = lease.detail ?? 'output_audio_unavailable'
      this.report(lease, lease.detail)
      this.beginRelease(lease)
    })
    child.once('close', (code, signal) => finish(code, signal))
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
    const startup = setTimeout(() => {
      if (lease.ready || lease.finished || lease.exiting) return
      lease.detail = 'output_audio_unavailable'
      this.report(lease, lease.detail)
      this.beginRelease(lease)
    }, 8000)
    startup.unref(); lease.timers.push(startup)
    return lease
  }

  start(id: string, mode: 'off' | 'duck' | 'mute') {
    if (this.disposed || this.wanted === id) return
    this.wanted = id; this.update()
    this.serial = this.serial.then(async () => {
      await this.release()
      if (this.wanted !== id || this.disposed) return
      if (mode === 'off') return
      if (!this.state.supported || !existsSync(this.executable())) {
        this.update({ phase: 'error', mode, detail: 'output_audio_unavailable' })
        this.notice(id, 'output_audio_unavailable'); return
      }
      this.launch(mode, id)
    }).catch(() => {
      if (this.wanted === id && !this.disposed) {
        this.update({ phase: 'error', mode, detail: 'output_audio_unavailable' })
        try { this.notice(id, 'output_audio_unavailable') } catch {}
      }
    })
  }

  stop() {
    this.wanted = undefined; this.update()
    this.serial = this.serial.then(() => this.release()).catch(() => {})
  }

  private beginRelease(lease: LeaseProcess) {
    if (lease.exiting || lease.finished) return
    lease.exiting = true
    if (this.active === lease) this.update({ phase: 'restoring' })
    // EOF is the normal shutdown path. In Windows kill() is TerminateProcess,
    // so it is used only after a bounded grace period, never on normal quit.
    lease.process.stdin?.end()
    for (const [delay, signal] of [[6000, 'SIGTERM'], [9000, 'SIGKILL']] as const) {
      const timer = setTimeout(() => {
        if (lease.finished) return
        lease.forced = true
        try { lease.process.kill(signal) } catch {}
      }, delay)
      timer.unref(); lease.timers.push(timer)
    }
  }

  private async release() {
    const lease = this.active
    if (!lease) return
    this.beginRelease(lease)
    await lease.closed
  }

  private recover(force = false): Promise<void> {
    if (this.disposed || this.wanted !== undefined || !this.state.supported) return Promise.resolve()
    if (this.recoveryQueued) return this.serial
    if (!force && !existsSync(this.journal)) return Promise.resolve()
    this.recoveryQueued = true
    this.serial = this.serial.then(async () => {
      await this.release()
      if (this.disposed || this.wanted !== undefined) return
      if (!existsSync(this.journal)) {
        this.update({ phase: 'idle', mode: 'off', detail: undefined }); return
      }
      if (!existsSync(this.executable())) {
        this.update({ phase: 'error', mode: 'off', detail: 'output_audio_unavailable' }); return
      }
      const lease = this.launch('recover', '')
      this.beginRelease(lease)
      await lease.closed
    }).catch(() => {
      if (!this.disposed) this.update({ phase: 'error', mode: 'off', detail: 'output_audio_unavailable' })
    }).finally(() => { this.recoveryQueued = false })
    return this.serial
  }

  async retryRecovery(): Promise<OutputAudioStatus> {
    if (this.wanted !== undefined) throw new Error('output_audio_recording')
    await this.recover(true)
    return this.snapshot()
  }

  dispose() {
    this.disposed = true; this.wanted = undefined; clearInterval(this.recovery)
    if (this.active) {
      this.beginRelease(this.active)
      // Keep the helper alive long enough to restore after Electron exits.
      this.active.process.unref()
    }
  }
}
