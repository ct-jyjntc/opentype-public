import type { LocalAsrProcess } from './process'
import type { SenseVoiceModelStore } from './model-store'

/** Both complete recordings and pause segments pass the same readiness check. */
export function withModelReadiness(engine: Pick<LocalAsrProcess, 'transcribe'>, models: SenseVoiceModelStore) {
  return {
    async transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text?: string; error?: string }> {
      if (signal?.aborted) return { error: 'cancelled' }
      const status = await models.check()
      if (signal?.aborted) return { error: 'cancelled' }
      if (status.state !== 'ready') return { error: 'model_not_ready' }
      return engine.transcribe(audio, signal)
    },
  }
}
