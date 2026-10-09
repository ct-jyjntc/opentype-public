import { randomUUID } from 'node:crypto'
import type { CardPayload } from '../../shared/desktop'
import type { DeliveryOutcome } from './input-delivery'

export interface AnswerSelection { token: string; selectedText: string; appName: string }
export interface AnswerCardDeps {
  show: (payload: CardPayload) => void
  release: (token: string) => void
  deliver: (token: string, text: string, signal: AbortSignal) => Promise<DeliveryOutcome>
  validate: (payload: CardPayload) => Promise<void>
  saveDelivery: (payload: CardPayload, outcome: DeliveryOutcome | { status: 'failed'; detail: string }) => Promise<void>
}
interface PendingAnswer {
  payload: CardPayload
  selection?: AnswerSelection
  controller: AbortController
  released: boolean
  used: boolean
}
/** Owns at most one original selection. Native handles never enter renderer data.
 * A card action applies its immutable answer once, only to that original target. */
export class AnswerCardSession {
  private pending?: PendingAnswer
  constructor(private readonly deps: AnswerCardDeps) {}
  present(payload: CardPayload, selection?: AnswerSelection): boolean {
    this.close()
    if (!selection?.selectedText || !selection.token) selection = undefined
    const current: PendingAnswer = {
      payload: { text: payload.text, title: payload.title, audioId: payload.audioId, contextNotice: payload.contextNotice, origin: payload.origin,
        id: randomUUID(), canReplaceSelection: !!selection, targetAppName: selection?.appName },
      selection, controller: new AbortController(), released: false, used: false,
    }
    this.pending = current
    try { this.deps.show(current.payload) }
    catch (error) { this.close(); throw error }
    return !!selection
  }
  private release(current: PendingAnswer) {
    if (current.released) return
    current.released = true
    if (current.selection) this.deps.release(current.selection.token)
  }
  close() {
    const current = this.pending
    this.pending = undefined
    if (current) { current.controller.abort(); this.release(current) }
  }
  async replace(id: string): Promise<void> {
    const current = this.pending
    if (!current || current.payload.id !== id || !current.selection || current.used) throw new Error('answer_selection_expired')
    current.used = true
    current.payload = { ...current.payload, canReplaceSelection: false, applyingSelection: true }
    this.deps.show(current.payload)
    let outcome: DeliveryOutcome | { status: 'failed'; detail: string }
    try {
      await this.deps.validate(current.payload)
      current.controller.signal.throwIfAborted()
      outcome = await this.deps.deliver(current.selection.token, current.payload.text, current.controller.signal)
    } catch (error) {
      if (!current.controller.signal.aborted && (error as Error).message === 'answer_recording_busy') {
        current.used = false
        current.payload = { ...current.payload, applyingSelection: false, canReplaceSelection: true, detail: 'answer_recording_busy' }
        if (this.pending === current) this.deps.show(current.payload)
        return
      }
      // deliverToInput converts errors after attempted submission to unverified;
      // only errors known to precede submission can reach this branch.
      outcome = { status: 'failed', detail: current.controller.signal.aborted ? 'cancelled' : (error as Error).message || 'injection_failed' }
    }
    this.release(current)
    let detail = outcome.status === 'verified' ? 'answer_selection_replaced' : outcome.detail
    try { if (!(outcome.status === 'failed' && current.controller.signal.aborted)) await this.deps.saveDelivery(current.payload, outcome) }
    catch { detail = outcome.status === 'failed' ? 'answer_selection_save_failed' : 'injection_history_save_failed' }
    // Closing or replacing a card during the operation never revives the old UI.
    if (this.pending === current) {
      current.payload = { ...current.payload, applyingSelection: false, canReplaceSelection: false, detail }
      this.deps.show(current.payload)
    }
  }
}
