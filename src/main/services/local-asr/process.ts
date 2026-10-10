export interface AsrChild {
  on(event: 'message', fn: (message: { id: number; text?: string; error?: string; progress?: boolean }) => void): unknown
  on(event: 'exit', fn: () => void): unknown
  postMessage(message: unknown): void
  kill(): unknown
}

/** One native job at a time; progress keeps long jobs alive, cancellation terminates inference. */
export class LocalAsrProcess {
  private child?: AsrChild
  private current?: { finish: (value: { text?: string; error?: string }) => void; progress: () => void }
  private idle?: ReturnType<typeof setTimeout>
  private sequence = 0
  constructor(private readonly spawn: () => AsrChild, private readonly modelDir: string,
    private readonly timeoutMs = 30_000, private readonly idleMs = 120_000) {}

  /** `language` is a SenseVoice id (auto/zh/en/ja/ko/yue); the worker falls back to auto. */
  transcribe(audio: Uint8Array, signal?: AbortSignal, language = 'auto'): Promise<{ text?: string; error?: string }> {
    if (signal?.aborted) return Promise.resolve({ error: 'cancelled' })
    if (this.current) return Promise.resolve({ error: 'local_asr_busy' })
    clearTimeout(this.idle)
    try { this.child ??= this.spawn() } catch { return Promise.resolve({ error: 'local_asr_unavailable' }) }
    const child = this.child, id = ++this.sequence
    return new Promise(resolve => {
      const finish = (value: { text?: string; error?: string }) => {
        if (this.current?.finish !== finish) return
        clearTimeout(timeout); signal?.removeEventListener('abort', abort)
        this.current = undefined
        this.idle = setTimeout(() => this.stop(), this.idleMs)
        this.idle.unref?.()
        resolve(value)
      }
      const abort = () => { this.stop(); finish({ error: 'cancelled' }) }
      let timeout: ReturnType<typeof setTimeout>
      const armWatchdog = () => {
        clearTimeout(timeout)
        timeout = setTimeout(() => { this.stop(); finish({ error: 'local_asr_timeout' }) }, this.timeoutMs)
      }
      armWatchdog()
      this.current = { finish, progress: armWatchdog }
      // Each new child gets a single listener. Routing by id ignores obsolete results.
      if (!(child as AsrChild & { bound?: boolean }).bound) {
        (child as AsrChild & { bound?: boolean }).bound = true
        child.on('message', value => {
          if (this.child === child && value.id === this.sequence) {
            if (value.progress) this.current?.progress()
            else this.current?.finish(value)
          }
        })
        child.on('exit', () => {
          if (this.child === child) { this.child = undefined; this.current?.finish({ error: 'local_asr_crashed' }) }
        })
      }
      signal?.addEventListener('abort', abort, { once: true })
      try { child.postMessage({ id, modelDir: this.modelDir, audio, language }) }
      catch { this.stop(); finish({ error: 'local_asr_failed' }) }
    })
  }

  private stop() { const child = this.child; this.child = undefined; child?.kill(); clearTimeout(this.idle) }
  dispose() { this.stop(); this.current?.finish({ error: 'cancelled' }); clearTimeout(this.idle) }
}
