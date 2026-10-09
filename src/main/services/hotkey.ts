// 热键状态机：把原生层抛出的裸按键事件流，翻译成「开始录音 / 结束录音」的语义事件。
//
// 为什么不直接用 Electron 的 globalShortcut：
// globalShortcut 只能响应「按下」，拿不到「松开」，无法实现按住说话（push-to-talk），
// 而且它会独占按键、吞掉组合键，影响用户在其他应用里的正常使用。

import type { KeyEvent } from '../native/ffi'
import type { RecordingActivation } from '../../shared/desktop'

export type HotkeyAction = 'start' | 'stop' | 'cancel'

export interface HotkeyBinding {
  /** 主键名，如 "F1"、"Space"、"D" */
  key: string
  /** Alternate bindings with the same action can stop the same toggle recording. */
  actionId?: string
  /**
   * 需要同时按住的修饰键。
   *
   * 原生层只会上报 Command/Control/Option/Shift，但配置里允许出现 "Fn"
   * （默认配置就是这么写的，Fn 在 macOS 上走 flagsChanged 而非标准修饰键标志位），
   * 所以这里放宽为 string[]。
   */
  modifiers: string[]
  /** 按住说话（true）还是按一下开始/再按一下结束（false） */
  pushToTalk: boolean
  /** Explicit preference; omitted bindings preserve the legacy pushToTalk behavior. */
  activation?: RecordingActivation
  /** A solo physical modifier retains its left/right identity. */
  keyCode?: number
}

export interface HotkeyEvent {
  action: HotkeyAction
  binding: HotkeyBinding
}

export const HOLD_THRESHOLD_MS = 300
const DEBOUNCE_MS = 180
interface Clock {
  now(): number
  schedule(fn: () => void, ms: number): unknown
  clear(timer: unknown): void
}
const systemClock: Clock = {
  now: () => performance.now(),
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer },
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
type HeldKey = { key: string; code?: number }
type Press = { binding: HotkeyBinding; started: number; keys: HeldKey[]; modifierOnly: boolean }
type Pending = Press & { timer?: unknown }
const activation = (binding: HotkeyBinding) => binding.activation ?? (binding.pushToTalk ? 'hold' : 'toggle')

/** One gesture owns a recording. Modifier prefixes wait before activating to avoid Cmd+C. */
export class HotkeyStateMachine {
  private bindings: HotkeyBinding[] = []
  private active: HotkeyBinding | null = null
  private press?: Press
  private pending?: Pending
  private modifiers = new Map<string, HeldKey>()
  private lastTrigger = -Infinity

  constructor(private readonly onEvent: (e: HotkeyEvent) => unknown, private readonly clock: Clock = systemClock) {}

  setBindings(bindings: HotkeyBinding[]): void {
    this.reset()
    this.bindings = bindings
  }

  /** Called for external stop, cancellation, capture failure, reconfiguration and sleep. */
  reset(): void {
    this.clearPending()
    this.active = null
    this.press = undefined
    this.modifiers.clear()
    this.lastTrigger = -Infinity
  }

  handle(event: KeyEvent): void {
    if (event.isRepeat) return
    const ev = { ...event, key: canonicalKeyName(event.key), modifiers: [...new Set(event.modifiers.map(canonicalKeyName))] }
    const identity = `${ev.key}:${ev.keyCode}`
    if (ev.type === 'keyUp') {
      this.modifiers.delete(identity)
      const pending = this.pending
      if (pending && this.releases(pending, ev)) {
        this.clearPending()
        if (activation(pending.binding) !== 'hold') this.activate(pending, true)
        return
      }
      if (this.press && this.releases(this.press, ev)) {
        const mode = activation(this.press.binding)
        const held = this.clock.now() - this.press.started >= HOLD_THRESHOLD_MS
        this.press = undefined
        if (mode === 'hold' || (mode === 'auto' && held)) this.finish('stop')
      }
      return
    }
    this.clearPending()
    if (isModifier(ev.key)) this.modifiers.set(identity, { key: ev.key, code: ev.keyCode })
    // Turning a held modifier into a normal shortcut cancels its provisional dictation.
    if (this.press?.modifierOnly && !this.press.keys.some(k => k.key === ev.key && k.code === ev.keyCode)) {
      this.finish('cancel')
      this.lastTrigger = -Infinity
    }
    let binding = this.matchBinding(ev)
    if (!binding) return
    if (this.active && this.active !== binding) {
      if (binding.actionId && binding.actionId === this.active.actionId && !this.press && activation(this.active) !== 'hold') binding = this.active
      else return
    }
    const keys: HeldKey[] = [{ key: ev.key, code: ev.keyCode }]
    for (const mod of ev.modifiers) {
      const known = [...this.modifiers.values()].filter(k => k.key === mod)
      keys.push(...(known.length ? known : [{ key: mod }]))
    }
    const press: Press = { binding, keys, started: this.clock.now(), modifierOnly: keys.every(k => isModifier(k.key)) }
    if (press.modifierOnly) {
      const pending: Pending = { ...press }
      this.pending = pending
      if (activation(binding) !== 'toggle') pending.timer = this.clock.schedule(() => {
        if (this.pending !== pending) return
        this.pending = undefined
        this.activate(pending)
      }, HOLD_THRESHOLD_MS)
    } else this.activate(press)
  }

  private activate(press: Press, released = false): void {
    const now = this.clock.now()
    if (now - this.lastTrigger < DEBOUNCE_MS) return
    if (this.active) {
      if (this.active === press.binding && activation(this.active) !== 'hold') {
        this.lastTrigger = now
        this.finish('stop')
      }
      return
    }
    this.lastTrigger = now
    this.active = press.binding
    this.press = released ? undefined : press
    // A busy/disabled recorder can reject a start without leaving a phantom active hotkey.
    if (this.onEvent({ action: 'start', binding: press.binding }) === false) this.reset()
  }

  private releases(press: Press, ev: KeyEvent): boolean {
    return press.keys.some(k => k.key === ev.key && (k.code === undefined || k.code === ev.keyCode))
  }

  private clearPending(): void {
    if (this.pending?.timer !== undefined) this.clock.clear(this.pending.timer)
    this.pending = undefined
  }

  private finish(action: 'stop' | 'cancel'): void {
    const binding = this.active
    this.active = null
    this.press = undefined
    this.clearPending()
    if (binding) this.onEvent({ action, binding })
  }

  handleCancel(): void {
    this.finish('cancel')
    this.reset()
  }

  private matchBinding(ev: KeyEvent): HotkeyBinding | null {
    return this.bindings.find(b => {
      if (b.keyCode !== undefined && b.keyCode !== ev.keyCode) return false
      const expected = [b.key, ...b.modifiers]
      const actual = [ev.key, ...ev.modifiers]
      if (expected.length !== actual.length) return false
      if (isModifier(b.key) && isModifier(ev.key)) return expected.every(key => actual.includes(key))
      return b.key === ev.key && b.modifiers.every(m => ev.modifiers.includes(m))
    }) ?? null
  }

  get recording(): boolean { return !!this.active }
  get releaseToStop(): boolean {
    return !!this.press && (activation(this.press.binding) === 'hold' ||
      (activation(this.press.binding) === 'auto' && this.clock.now() - this.press.started >= HOLD_THRESHOLD_MS))
  }
}

/**
 * 渲染层修饰键别名 → 内部表示。
 *
 * 渲染层设置页用 LeftCmd/RightAlt 这种带左右的命名（区分物理键位置），
 * 原生层上报时只给 Command/Option 这种语义名，匹配前必须先归一。
 * Fn 特殊：它不是标准修饰键标志位，但热键配置把它当修饰键用（Fn+Space）。
 */
const MODIFIER_ALIASES: Record<string, string> = {
  fn: 'Fn',
  shift: 'Shift', leftshift: 'Shift', rightshift: 'Shift',
  leftcommand: 'Command', rightcommand: 'Command',
  cmd: 'Command', command: 'Command', leftcmd: 'Command', rightcmd: 'Command',
  meta: 'Command', super: 'Command', win: 'Command',
  leftcontrol: 'Control', rightcontrol: 'Control',
  ctrl: 'Control', control: 'Control', leftctrl: 'Control', rightctrl: 'Control',
  alt: 'Option', option: 'Option', leftalt: 'Option', rightalt: 'Option',
  leftoption: 'Option', rightoption: 'Option'
}

const PHYSICAL_MODIFIERS: Record<string, number> = {
  leftcommand: 0x37, leftcmd: 0x37, rightcommand: 0x36, rightcmd: 0x36,
  leftcontrol: 0x3b, leftctrl: 0x3b, rightcontrol: 0x3e, rightctrl: 0x3e,
  leftshift: 0x38, rightshift: 0x3c,
  leftoption: 0x3a, leftalt: 0x3a, rightoption: 0x3d, rightalt: 0x3d,
}
const WINDOWS_PHYSICAL_MODIFIERS: Record<string, number> = {
  leftcommand: 0x5b, leftcmd: 0x5b, rightcommand: 0x5c, rightcmd: 0x5c,
  leftcontrol: 0xa2, leftctrl: 0xa2, rightcontrol: 0xa3, rightctrl: 0xa3,
  leftshift: 0xa0, rightshift: 0xa1,
  leftoption: 0xa4, leftalt: 0xa4, rightoption: 0xa5, rightalt: 0xa5,
}
function isModifier(key: string): boolean {
  return ['Fn', 'Command', 'Control', 'Option', 'Shift'].includes(key)
}

/** 归一主键名：修饰键别名走别名表，单字母统一大写，其余原样透传。 */
function canonicalKeyName(name: string): string {
  const alias = MODIFIER_ALIASES[name.toLowerCase()]
  if (alias) return alias
  if (/^[a-z]$/.test(name)) return name.toUpperCase()
  return name
}

/**
 * 把渲染层的快捷键描述字符串解析为内部绑定。
 *
 * 渲染层格式（store:use 的 app-settings.featureShortcutBindings 值）：
 * "Fn" / "Fn+Space" / "Fn+LeftShift" / "LeftCtrl+RightShift+V"，
 * 以 '+' 连接，最后一段是主键，前面都是修饰键。
 *
 * 与渲染层的解析函数（构建产物里的 Yr）保持一致：
 * KeypadAdd/NumpadAdd 内部不含 '+'，直接 split 是安全的。
 *
 * 解析失败（空串、修饰键位出现普通键）返回 null，调用方应回落到默认绑定。
 */
export function parseShortcutString(shortcut: string): HotkeyBinding | null {
  if (typeof shortcut !== 'string') return null
  const parts = shortcut.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const key = canonicalKeyName(parts[parts.length - 1])
  if (!key) return null

  const modifiers: string[] = []
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    // 修饰键位出现无法识别的键名：这个绑定无法表达，放弃而不是乱猜
    if (!mod) return null
    if (!modifiers.includes(mod)) modifiers.push(mod)
  }
  const physical = process.platform === 'win32' ? WINDOWS_PHYSICAL_MODIFIERS : PHYSICAL_MODIFIERS
  const keyCode = parts.length === 1 ? physical[parts[0].toLowerCase()] : undefined
  return { key, modifiers, pushToTalk: false, ...(keyCode !== undefined ? { keyCode } : {}) }
}
