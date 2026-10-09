import type { HotkeyEvent, HotkeyStateMachine } from './hotkey'
import type { VoiceState } from '../../shared/desktop'

interface RecorderControls {
  enabled(): boolean
  busy(): boolean
  recording(): boolean
  start(event: HotkeyEvent): void
  stop(): void
  cancel(): void
}

/** UI/tray captures and keyboard captures share the same stop and busy semantics. */
export function dispatchRecordingHotkey(event: HotkeyEvent, controls: RecorderControls): boolean | void {
  if (event.action === 'start') {
    if (!controls.enabled()) return false
    if (controls.busy()) {
      if (controls.recording()) controls.stop()
      return false
    }
    controls.start(event)
    return controls.busy()
  }
  if (event.action === 'stop') controls.stop()
  else controls.cancel()
}

export function reconcileCaptureState(hotkeys: HotkeyStateMachine, state: VoiceState): VoiceState {
  if (state.phase === 'preparing' || state.phase === 'recording') return { ...state, stopGesture: hotkeys.releaseToStop ? 'release' : 'press' }
  hotkeys.reset()
  return state
}

type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'
interface PowerEvents {
  on(event: PowerEvent, listener: () => void): unknown
  removeListener(event: PowerEvent, listener: () => void): unknown
}
export function bindRecordingPowerEvents(source: PowerEvents, controls: {
  suspend(): void
  resume(): void
}) {
  let sleeping = false, locked = false
  const paused = () => sleeping || locked
  const recover = () => { if (!paused()) controls.resume() }
  const listeners: Record<PowerEvent, () => void> = {
    suspend: () => { sleeping = true; controls.suspend() },
    resume: () => { sleeping = false; recover() },
    'lock-screen': () => { locked = true; controls.suspend() },
    'unlock-screen': () => { locked = false; recover() },
  }
  for (const [event, listener] of Object.entries(listeners)) source.on(event as PowerEvent, listener)
  return { paused, dispose: () => {
    for (const [event, listener] of Object.entries(listeners)) source.removeListener(event as PowerEvent, listener)
  } }
}
