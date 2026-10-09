import type { KeyEvent } from '../native/keyboard'
import type { ShortcutCaptureState } from '../../shared/desktop'

const modifiers = new Set(['Fn', 'Command', 'Control', 'Option', 'Shift', 'LeftCommand', 'RightCommand', 'LeftControl', 'RightControl', 'LeftOption', 'RightOption', 'LeftShift', 'RightShift'])
const generic = (key: string) => key.replace(/^(Left|Right)/, '')
function chordName(keys: string[]): string {
  const chars = keys.filter(key => !modifiers.has(key))
  const mods = keys.filter(key => modifiers.has(key))
  if (keys.length === 1) return keys[0]
  // Fn+Shift works regardless of the order in which the modifiers were pressed.
  mods.sort((a, b) => (a === 'Fn' ? -1 : b === 'Fn' ? 1 : 0))
  return [...mods, ...chars].join('+')
}

/** Captured events never reach recording. End drains held keys and late native deliveries. */
export class ShortcutCapture {
  private session?: { id: string; owner: number; emit: (state: ShortcutCaptureState) => void }
  private pressed = new Set<string>()
  private chord: string[] = []
  private draining = new Set<string>()
  private endedAt = 0
  get active() { return !!this.session }
  get owner() { return this.session?.owner }
  begin(id: string, owner: number, emit: (state: ShortcutCaptureState) => void) {
    this.end()
    this.session = { id, owner, emit }
    this.pressed.clear()
    this.chord = []
  }
  end(id?: string, reason: ShortcutCaptureState['reason'] = 'closed') {
    const session = this.session
    if (!session || (id && session.id !== id)) return
    this.draining = new Set(this.pressed)
    this.pressed.clear()
    this.endedAt = Date.now()
    this.session = undefined
    session.emit({ id: session.id, active: false, reason })
  }
  handle(event: KeyEvent): boolean {
    if (!this.session) {
      if (event.timestamp && event.timestamp <= this.endedAt) return true
      if (this.draining.has(event.key)) {
        this.draining.delete(event.key)
        if (event.type === 'keyUp' || event.isRepeat) return true
      }
      return false
    }
    if (event.key === 'Escape') { this.end(undefined, 'cancelled'); return true }
    if (event.isRepeat) return true
    if (event.type === 'keyUp') {
      this.pressed.delete(event.key)
      return true
    }
    // A shortcut has only one ordinary key. Replace it on the next key-down,
    // including platforms that omit key-up after a prevented menu accelerator.
    for (const key of this.pressed) if (!modifiers.has(key) && key !== event.key) this.pressed.delete(key)
    if (this.pressed.has(event.key)) return true // Native and focused-window events can both arrive.
    if (this.pressed.size === 0) this.chord = []
    this.pressed.add(event.key)
    this.chord = [...this.pressed]
    // Include flags in case the editor was opened while a modifier was held.
    for (const mod of event.modifiers) {
      if (!this.chord.some(key => generic(key) === generic(mod))) this.chord.push(mod)
    }
    const index = this.chord.findIndex(key => generic(key) === generic(event.key))
    if (index >= 0) this.chord[index] = event.key
    else this.chord.push(event.key)
    this.session.emit({ id: this.session.id, active: true, shortcut: chordName(this.chord) })
    return true
  }
}

/** Chromium events cover ordinary keys even without global input permission; Fn uses native events. */
export function focusedKeyEvent(input: {
  type: string; key: string; code: string; isAutoRepeat?: boolean
  shift?: boolean; control?: boolean; alt?: boolean; meta?: boolean
}): KeyEvent | null {
  if (!['keyDown', 'keyUp'].includes(input.type)) return null
  const physical: Record<string, string> = {
    MetaLeft: 'LeftCommand', MetaRight: 'RightCommand',
    ControlLeft: 'LeftControl', ControlRight: 'RightControl',
    AltLeft: 'LeftOption', AltRight: 'RightOption', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
    Space: 'Space', Escape: 'Escape', Fn: 'Fn',
  }
  const key = physical[input.code] ?? (/^(Key[A-Z]|Digit[0-9])$/.test(input.code) ? input.code.replace(/^(Key|Digit)/, '') : input.key)
  const flags = [[input.meta, 'Command'], [input.control, 'Control'], [input.alt, 'Option'], [input.shift, 'Shift']] as const
  return { type: input.type as KeyEvent['type'], key, keyCode: -1,
    modifiers: flags.filter(([down, name]) => down && name !== generic(key)).map(([, name]) => name),
    isRepeat: !!input.isAutoRepeat, timestamp: Date.now() }
}
