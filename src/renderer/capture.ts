import type { Preferences } from '../shared/desktop'
import { RecordingCues } from './audio/recording-cues'
import { AudioCaptureManager } from './audio/capture-manager'
// Vite emits the compiled worklet as a worker entry, never executes it on the UI thread.
import workletUrl from './audio/worklet.ts?worker&url'
const api = window.opentype
/** The always-resident bar is the sole microphone owner, even when the hub is closed. */
export function wireCaptureLifecycle(getDeviceId: () => string, getPreferences: () => Pick<Preferences, 'interactionSounds' | 'audioProcessing'> | undefined = () => undefined): () => void {
  const manager = new AudioCaptureManager(workletUrl), cues = new RecordingCues()
  let sounds = false
  let currentId: string | undefined,
    queue = Promise.resolve(),
    disposed = false
  const enqueue = (fn: () => Promise<void>) => {
    queue = queue.then(fn).catch(() => {})
  }
  const off = api.desktop.recording.onState((state) => {
    if (
      state.phase === 'recording' &&
      state.audioId &&
      currentId !== state.audioId
    ) {
      const id = state.audioId
      currentId = id
      enqueue(async () => {
        await manager.stop()
        if (currentId !== id || disposed) return
        try {
          const preferences = getPreferences()
          sounds = preferences?.interactionSounds === true
          await manager.start({
            processing: preferences?.audioProcessing,
            onDeviceEnded: () => { if (currentId === id) api.desktop.recording.failed(id, 'microphone_disconnected') },
            deviceId: getDeviceId(),
            onChunk: ({ samples }) => {
              if (currentId === id) api.capture.pushAudio(samples, 16000, 0, id)
            },
            onLevel: (level) => {
              if (currentId === id) api.capture.pushLevel(level)
            },
          })
          if (currentId !== id || disposed) await manager.stop()
          else if (sounds) void cues.play('start')
        } catch (error) {
          if (currentId === id) {
            currentId = undefined
            const name = (error as Error).name
            api.desktop.recording.failed(id, name === 'NotAllowedError' ? 'microphone_permission'
              : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'microphone_missing'
              : name === 'NotReadableError' ? 'microphone_busy' : 'capture_failed')
          }
        }
      })
    } else if (['error', 'cancelled', 'done'].includes(state.phase)) {
      if (state.audioId && currentId !== state.audioId) return
      const wasRecording = !!currentId
      currentId = undefined
      enqueue(async () => { await manager.stop(); if (wasRecording && sounds) void cues.play('cancel') })
    }
  })
  const offFlush = api.desktop.recording.onFlush((id) =>
    enqueue(async () => {
      if (currentId === id) {
        await manager.stop()
        if (sounds) void cues.play('stop')
        if (currentId === id) currentId = undefined
      }
      api.desktop.recording.flushed(id)
    }),
  )
  return () => {
    disposed = true
    currentId = undefined
    off()
    offFlush()
    enqueue(async () => { await manager.dispose(); await cues.dispose() })
  }
}
