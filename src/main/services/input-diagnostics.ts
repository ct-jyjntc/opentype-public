import { app } from 'electron'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '../../shared/desktop'

const keys = new Set(['reason', 'ok', 'submitted', 'uncertain', 'status', 'method', 'trusted', 'frontPid', 'frontBundleId', 'targetPid', 'targetBundleId', 'role', 'valueReadable', 'valueSettable', 'rangeReadable', 'rangeSettable', 'focusError', 'focusSource', 'globalFocusError', 'appFocusError', 'initialFocusError', 'focusRetries', 'pidError', 'focusMatches', 'frontMatches', 'focusReadable', 'axBootstrapAttempted', 'axBootstrapError', 'axForced', 'activateOk', 'raiseError', 'setFocusError', 'setRangeError'])
const stages = new Set(['capture-start', 'capture-result', 'capture-bridge', 'prepare-start', 'prepare-result', 'prepare-bridge', 'ready', 'ready-bridge', 'commit-start', 'commit-result', 'commit-bridge', 'verify', 'verify-bridge', 'delivery-start', 'delivery-result', 'delivery-failed'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function safeReason(value: unknown): value is string { return typeof value === 'string' && /^injection_[a-z_]+$/.test(value) && errorMessage(value) !== value }
export function inputDiagnosticReason(value: unknown) { return safeReason(value) ? value : undefined }
function regular(path: string) { const state = lstatSync(path); return state.isFile() && !state.isSymbolicLink() }
function sanitize(metadata: Record<string, unknown>) {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!keys.has(key)) continue
    if (key === 'reason' && !safeReason(value)) continue
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) safe[key] = value
    else if (typeof value === 'string') {
      if ((key === 'frontBundleId' || key === 'targetBundleId') && !/^[a-zA-Z0-9._-]{0,160}$/.test(value)) continue
      if (key === 'role' && !/^AX[a-zA-Z0-9]{1,80}$/.test(value)) continue
      if (key === 'focusSource' && !['system', 'application', 'none'].includes(value)) continue
      if (key === 'method' && !['clipboard', 'unknown'].includes(value)) continue
      if (key === 'status' && !['verified', 'unverified', 'pending'].includes(value)) continue
      safe[key] = value.slice(0, 160)
    }
  }
  return safe
}
const limit = 1024 * 1024
export function diagnosticPath() { return join(app.getPath('userData'), 'logs', 'input-delivery.jsonl') }
/** Fixed scalar allowlist: never persist input values, selection, URLs, native handles or exception messages. */
export function recordInputDiagnostic(traceId: string, stage: string, metadata: Record<string, unknown> = {}) {
  try {
    const file = diagnosticPath()
    const directory = join(app.getPath('userData'), 'logs')
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) return
    mkdirSync(directory, { recursive: true })
    for (const path of [file, file + '.1', file + '.2']) if (existsSync(path) && !regular(path)) return
    if (!uuid.test(traceId) || !stages.has(stage)) return
    if (existsSync(file) && statSync(file).size >= limit) {
      if (existsSync(file + '.2')) unlinkSync(file + '.2')
      if (existsSync(file + '.1')) renameSync(file + '.1', file + '.2')
      renameSync(file, file + '.1')
    }
    const safe = sanitize(metadata)
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), traceId, stage, ...safe }) + '\n', { mode: 0o600 })
  } catch { /* Diagnostics must never prevent capture or retry a submitted write. */ }
}
export function readInputDiagnostics(traceId?: string) {
  const events: Record<string, unknown>[] = []
  const file = diagnosticPath()
  for (const path of [file + '.2', file + '.1', file]) {
    try {
      if (!regular(path) || statSync(path).size > limit + 16384) continue
      const directory = join(app.getPath('userData'), 'logs')
      if (lstatSync(directory).isSymbolicLink()) continue
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.traceId !== 'string' || !uuid.test(event.traceId) || !stages.has(event.stage)) continue
          if (!traceId || event.traceId === traceId) events.push({ at: typeof event.at === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(event.at) ? event.at.slice(0, 32) : '', version: typeof event.version === 'string' && /^[\d.a-z-]+$/.test(event.version) ? event.version.slice(0, 40) : '', traceId: event.traceId, stage: event.stage, ...sanitize(event) })
        } catch { /* incomplete final record */ }
      }
    } catch { /* no log yet */ }
  }
  const reversed = [...events].reverse()
  const terminal = reversed.find(event => event.stage === 'delivery-result' || event.stage === 'delivery-failed')
  const last = terminal ?? reversed.find(event => typeof event.reason === 'string' && event.reason)
  return { summary: { reason: last?.reason as string | undefined, stage: last?.stage as string | undefined }, events }
}
