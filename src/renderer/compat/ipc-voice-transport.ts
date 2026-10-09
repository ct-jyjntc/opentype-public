/** Batch voice transport used by the shipped renderer. All network selection stays in main. */
type Json = Record<string, any>
interface Handlers {
  onStateUpdate(state: Json): void
  onRefineCompleted(result: Json): void
  onError(error: { code: number; detail: string; needStop: boolean }): void
  onSessionInterrupt?(notification: unknown): void
  onReceivedChunkConfirm?(): void
}
interface Dependencies {
  invoke(channel: string, payload: Json): Promise<any>
  eventManager: {
    broadcastMessageLifecycle(type: string, data: Json, original: Json): void
    destroy(): void
  }
  timeoutMs?: number
}
interface Pending { abortId: string; cancelled: boolean; cancel: () => void }

export class IpcVoiceTransport {
  private state: Json = this.initialState()
  private requests = new Map<string, Pending>()
  private completed = new Set<string>()
  private connected = false
  private disposed = false

  constructor(private readonly handlers: Handlers, private readonly deps: Dependencies) {}

  getState(): Json { return this.state }
  // The recorder still uses WebSocket numeric states; OPEN means the IPC transport is ready.
  getReadyState(): number { return this.connected ? 1 : 3 }
  isConnected(): boolean { return this.connected }
  isConnecting(): boolean { return false }
  async connect(): Promise<void> { if (!this.disposed) this.connected = true }
  disconnect(): void { this.connected = false; this.cancelAll() }

  sendMessage(audioId: string, message: Json): void {
    if (!audioId || this.disposed) return
    if (message.type === 'start_audio') {
      this.cancelAll()
      this.completed.delete(audioId)
      this.setState({ ...this.initialState(), currentAudioId: audioId })
    } else if (message.type === 'end_audio') {
      if (!this.requests.has(audioId) && !this.completed.has(audioId)) void this.run(audioId, message, false)
    }
    // Mode/selection/context updates are already persisted by the recorder before end_audio.
  }

  sendAudioChunk(audioId: string): void {
    // Chunks are retained by the recorder. Acknowledge local consumption so its queue stays
    // bounded; the complete recording is read from history when recording ends.
    if (!this.disposed && this.state.currentAudioId === audioId) this.handlers.onReceivedChunkConfirm?.()
  }

  async sendRetryRequest(audioId: string): Promise<void> {
    if (!audioId || this.disposed) return
    this.cancelAll()
    this.completed.delete(audioId)
    await this.run(audioId, {}, true)
  }
  clearCompletedAudioId(audioId: string): void { this.completed.delete(audioId) }
  cancelFallbackRequest(audioId: string): void { this.interruptSession(audioId) }

  interruptSession(audioId: string): void {
    const pending = this.requests.get(audioId)
    if (pending) {
      pending.cancelled = true
      pending.cancel()
      this.requests.delete(audioId)
      void this.bestEffort('audio:abort-ai-voice-flow-request', { abortId: pending.abortId })
    }
    if (this.state.currentAudioId === audioId) this.setState({ isRefining: false })
  }

  resetState(): void {
    this.cancelAll()
    this.completed.clear()
    this.setState(this.initialState())
  }
  cleanup(): void {
    this.cancelAll()
    this.disposed = true
    this.connected = false
    this.completed.clear()
    this.deps.eventManager.destroy()
  }

  private async run(audioId: string, message: Json, isRetry: boolean): Promise<void> {
    const request: Pending = { abortId: `${audioId}-${crypto.randomUUID()}`, cancelled: false, cancel: () => {} }
    this.requests.set(audioId, request)
    this.setState({ isRefining: true, currentAudioId: audioId, lastError: null })
    const current = () => !this.disposed && !request.cancelled && this.requests.get(audioId) === request
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = new Promise<never>((_, reject) => {
      request.cancel = () => reject(new Error('cancelled'))
      timer = setTimeout(() => reject(new Error('voice_request_timeout')), this.deps.timeoutMs ?? 120_000)
    })
    // A single deadline covers local compression, metadata persistence and provider work.
    const invoke = (channel: string, payload: Json) => Promise.race([this.deps.invoke(channel, payload), stop])
    try {
      const started = performance.now()
      const audio = await invoke('audio:opus-compress-by-audio-id', { audioId })
      if (!current()) return
      const bytes = audio?.outputArrayBuffer
      if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) || !bytes.byteLength) {
        throw new Error('recording_audio_unavailable')
      }
      await invoke('db:history-upsert-client-metadata', {
        id: audioId, metadata: { full_audio_compression_time_ms: performance.now() - started, voice_transport: 'ipc' }
      })
      if (!current()) return
      const result = await invoke('audio:ai-voice-flow', {
        audioId, arrayBuffer: bytes, abortId: request.abortId, isRetry,
        outputLanguage: message.mode_meta?.output_language,
        userOverTime: message.user_over_time, sendTime: message.send_time
      })
      if (!current()) return
      if (result?.aborted) { this.setState({ isRefining: false }); return }
      // Keep ASR original/error information available even when translation/refinement fails.
      await invoke('db:history-upsert-mode-meta', { id: audioId, modeMetaPatch: {
        raw_text: result?.raw_text ?? '', processing_detail: result?.detail ?? null
      } })
      if (!current()) return
      if (!result?.success && result?.paywall) {
        this.setState({ isRefining: false })
        this.handlers.onSessionInterrupt?.(result.paywall)
        return
      }
      if (!result?.success || typeof result.refine_text !== 'string' || !result.refine_text.trim()) {
        throw new Error(result?.detail || 'empty_transcription')
      }
      this.completed.add(audioId)
      this.setState({ isRefining: false, refinedResult: result.refine_text })
      this.handlers.onRefineCompleted({ audioId, refinedText: result.refine_text,
        delivery: result.delivery, user_prompt: result.user_prompt,
        web_metadata: result.web_metadata, external_action: result.external_action })
      this.deps.eventManager.broadcastMessageLifecycle('audio_processing_completed', {
        audio_id: audioId, refined_text: result.refine_text, delivery: result.delivery,
        user_prompt: result.user_prompt, web_metadata: result.web_metadata, external_action: result.external_action
      }, {})
    } catch (err) {
      if (!current()) return
      void this.bestEffort('audio:abort-ai-voice-flow-request', { abortId: request.abortId })
      const error = { code: 5000, detail: err instanceof Error ? err.message : 'voice_request_failed', needStop: true }
      this.setState({ isRefining: false, lastError: error })
      this.handlers.onError(error)
      this.deps.eventManager.broadcastMessageLifecycle('audio_processing_error', { audio_id: audioId, ...error }, {})
    } finally {
      clearTimeout(timer)
      if (this.requests.get(audioId) === request) this.requests.delete(audioId)
      // The "clean-opus" IPC used to delete the only recording. History owns its retention;
      // completion/cancellation must leave audio available for playback and retry.
    }
  }

  private async bestEffort(channel: string, payload: Json): Promise<void> {
    try { await this.deps.invoke(channel, payload) } catch { /* shutdown may close IPC first */ }
  }
  private cancelAll(): void { for (const id of this.requests.keys()) this.interruptSession(id) }
  private setState(patch: Json): void { this.state = { ...this.state, ...patch }; this.handlers.onStateUpdate(this.state) }
  private initialState(): Json {
    return { transcriptionChunks: [], refinedResult: '', isRefining: false, currentAudioId: null, lastError: null }
  }
}
