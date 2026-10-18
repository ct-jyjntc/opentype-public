import type { ContextEdit } from './providers/types'

export interface InputSnapshot {
  windowBounds?: { x: number; y: number; width: number; height: number }
  traceId?: string
  token?: string
  reason?: string
  appName: string
  bundleId: string
  pid: number
  role?: string
  selectedText?: string
  contextText?: string
  contextBefore?: string
  contextSelection?: string
  contextAfter?: string
  webUrl?: string
  webUrls?: string[]
  contextRedacted?: boolean
  selectionReadOnly?: boolean
  canVerify?: boolean
}

/** Chromium can expose its focused field shortly after AX is enabled. Wait
 * before recording the insertion baseline, retaining only one native token. */
export async function captureReadableInput(
  capture: (expectedPid?: number) => InputSnapshot,
  release: (token: string) => void,
  signal: AbortSignal,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<InputSnapshot> {
  signal.throwIfAborted()
  let snapshot = capture()
  const pid = snapshot.pid
  try {
    for (let attempt = 0; attempt < 12 && snapshot.canVerify === false
      && !snapshot.selectionReadOnly && (snapshot.token || snapshot.reason === 'injection_target_not_editable'); attempt++) {
      await pause(50)
      signal.throwIfAborted()
      const next = capture(pid)
      if (snapshot.token) release(snapshot.token)
      snapshot = next
      if (next.pid !== pid) {
        if (next.token) release(next.token)
        return { appName: '', bundleId: '', pid, traceId: next.traceId,
          contextRedacted: true, reason: 'injection_app_changed' }
      }
    }
    signal.throwIfAborted()
    return snapshot
  } catch (error) {
    if (snapshot.token) release(snapshot.token)
    throw error
  }
}
export interface DeliveryOutcome {
  status: 'verified' | 'unverified'
  method: string
  detail?: string
  contextEditApplied?: boolean
  contextEditReason?: string
}
export interface InputDeliveryNative {
  prepare(token: string): { ok?: boolean; reason?: string } | Promise<{ ok?: boolean; reason?: string }>
  ready(token: string): { ok?: boolean; reason?: string }
  commit(token: string, text: string, contextEdit?: ContextEdit): {
    submitted?: boolean; method?: string; uncertain?: boolean; reason?: string
    contextEditApplied?: boolean; contextEditReason?: string; retryable?: boolean
  } | Promise<{ submitted?: boolean; method?: string; uncertain?: boolean; reason?: string; contextEditApplied?: boolean; contextEditReason?: string; retryable?: boolean }>
  verify(token: string): { status?: 'verified' | 'unverified' | 'pending'; blind?: boolean; reason?: string }
}

/** Restoration may settle asynchronously. Only the native commit mutates text,
 * exactly once; verification never retries a paste, even after cancellation. */
export async function deliverToInput(
  native: InputDeliveryNative, snapshot: Pick<InputSnapshot, 'token' | 'reason'>, text: string, signal: AbortSignal,
  contextEdit?: ContextEdit,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<DeliveryOutcome> {
  signal.throwIfAborted()
  if (!snapshot.token) throw new Error(snapshot.reason || 'injection_target_unavailable')
  const token = snapshot.token
  // An edit with no side is just the body: deliver it the ordinary way.
  if (contextEdit && !contextEdit.before && !contextEdit.after) contextEdit = undefined
  const prepared = await native.prepare(token)
  if (!prepared.ok) throw new Error(prepared.reason || 'injection_target_unavailable')
  let ready = false, pendingReason = 'injection_target_unavailable'
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted()
    const state = native.ready(token)
    if (state.ok) { ready = true; break }
    // Chromium applies AX focus and selection changes asynchronously. The
    // native commit still rechecks the exact range immediately before paste.
    if (state.reason !== 'injection_focus_pending' && state.reason !== 'injection_selection_changed') throw new Error(state.reason || 'injection_target_unavailable')
    pendingReason = state.reason === 'injection_focus_pending' ? 'injection_focus_timeout' : state.reason
    await pause(40)
  }
  signal.throwIfAborted()
  if (!ready) throw new Error(pendingReason)
  let committed: Awaited<ReturnType<InputDeliveryNative['commit']>>
  try { committed = await native.commit(token, text, contextEdit) }
  catch {
    // A bridge failure cannot tell us whether the native side already posted
    // the paste. Do not offer an "unsent" fallback or automatically resend.
    return { status: 'unverified', method: 'unknown', detail: signal.aborted ? 'injection_cancelled_after_send' : 'injection_unverified',
      ...(contextEdit ? { contextEditReason: 'native_result_unavailable' } : {}) }
  }
  const contextOutcome = {
    ...(typeof committed.contextEditApplied === 'boolean' ? { contextEditApplied: committed.contextEditApplied } : {}),
    ...(committed.contextEditReason ? { contextEditReason: committed.contextEditReason } : {}),
  }
  if (committed.reason === 'injection_already_sent') return { status: 'unverified', method: committed.method || 'unknown', detail: committed.reason, ...contextOutcome }
  // The strict edit was refused before anything was posted (target moved, field
  // changed, edit unsupported). The punctuation tweak is optional; the text is not.
  // Native sets retryable:false when the expanded selection may still be in place.
  if (contextEdit && !committed.submitted && committed.contextEditReason && committed.retryable !== false) {
    const plain = await deliverToInput(native, snapshot, text, signal, undefined, pause)
    return { ...plain, contextEditApplied: false, contextEditReason: committed.contextEditReason }
  }
  if (!committed.submitted && !committed.reason) return { status: 'unverified', method: 'unknown', detail: 'injection_unverified', ...contextOutcome }
  if (!committed.submitted) throw new Error(committed.reason || 'injection_failed')
  const method = committed.method || 'unknown'
  for (let attempt = 0; attempt < 12 && !committed.uncertain; attempt++) {
    if (signal.aborted) return { status: 'unverified', method, detail: 'injection_cancelled_after_send', ...contextOutcome }
    let state: ReturnType<InputDeliveryNative['verify']>
    try { state = native.verify(token) }
    catch { break }
    if (state.status === 'verified') return { status: 'verified', method, ...contextOutcome }
    // The target app exposes no readable field (Windows blind typing): the
    // write went out and there is nothing to read back, so raise no warning.
    if (state.status === 'unverified' && state.blind) return { status: 'unverified', method, ...contextOutcome }
    if (state.status !== 'pending') break
    await pause(50)
  }
  return { status: 'unverified', method, detail: 'injection_unverified', ...contextOutcome }
}
