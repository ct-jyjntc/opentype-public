// 快捷键校验规则。
//
// 快捷键校验六条规则（依据界面文案 shortcuts__input__error__*）：
// 1. 不能只含字母数字 —— 否则会与正常输入冲突
// 2. 不能与其他快捷键重复
// 3. 禁止连续字母 —— 避免与快速输入混淆
// 4. 禁止连续数字
// 5. 排除系统保留组合
// 6. 最多 3 个键
//
// 这些规则不是凭空设的：缺少任何一条，用户都能配出一个「按下去就再也打不出字」的热键。

export interface ShortcutSpec {
  /** 主键名，如 "F1"、"Space"、"A" */
  key: string
  /** 修饰键 */
  modifiers: string[]
}

export type ValidationError =
  | 'empty'
  | 'alphanumeric_only'
  | 'already_in_use'
  | 'consecutive_letters'
  | 'consecutive_numbers'
  | 'system_reserved'
  | 'too_many_keys'

export interface ValidationResult {
  valid: boolean
  error?: ValidationError
}

/** 系统保留组合。这些被 macOS/Windows 自身占用，注册会失败或行为异常。 */
const SYSTEM_RESERVED: Array<{ key: string; modifiers: string[] }> = [
  // macOS 系统级
  { key: 'Space', modifiers: ['Command'] },        // Spotlight
  { key: 'Space', modifiers: ['Control'] },        // 输入法切换
  { key: 'Tab', modifiers: ['Command'] },          // 应用切换
  { key: 'Q', modifiers: ['Command'] },            // 退出应用
  { key: 'W', modifiers: ['Command'] },            // 关闭窗口
  { key: 'H', modifiers: ['Command'] },            // 隐藏应用
  { key: 'M', modifiers: ['Command'] },            // 最小化
  { key: 'Escape', modifiers: ['Command', 'Option'] }, // 强制退出
  // Windows 系统级
  { key: 'Tab', modifiers: ['Alt'] },
  { key: 'F4', modifiers: ['Alt'] },
  { key: 'Delete', modifiers: ['Control', 'Alt'] },
  { key: 'Escape', modifiers: ['Control', 'Shift'] }   // 任务管理器
]
const WINDOWS_RESERVED: ShortcutSpec[] = [
  { key: 'Command', modifiers: [] },
  ...['L', 'D', 'R', 'E', 'I', 'S', 'X', 'Tab'].map(key => ({ key, modifiers: ['Command'] })),
]

const MAX_KEYS = 3

/** 判断键名是否为单个字母。 */
function isLetter(key: string): boolean {
  return /^[A-Za-z]$/.test(key)
}

/** 判断键名是否为单个数字。 */
function isDigit(key: string): boolean {
  return /^[0-9]$/.test(key)
}

/** 判断两个键名是否在字母表/数字序列上相邻。 */
function isConsecutive(a: string, b: string): boolean {
  if (isLetter(a) && isLetter(b)) {
    return Math.abs(a.toUpperCase().charCodeAt(0) - b.toUpperCase().charCodeAt(0)) === 1
  }
  if (isDigit(a) && isDigit(b)) {
    return Math.abs(Number(a) - Number(b)) === 1
  }
  return false
}

function sameShortcut(a: ShortcutSpec, b: ShortcutSpec): boolean {
  const aliases: Record<string, string> = { Alt: 'Option', Ctrl: 'Control', Meta: 'Command', Win: 'Command' }
  const canonical = (key: string) => aliases[key] ?? key
  if (canonical(a.key) !== canonical(b.key)) return false
  if (a.modifiers.length !== b.modifiers.length) return false
  return a.modifiers.every((m) => b.modifiers.map(canonical).includes(canonical(m)))
}

/**
 * 校验单个快捷键。
 * @param spec 待校验的快捷键
 * @param others 已占用的其他快捷键（用于冲突检测）
 */
export function validateShortcut(spec: ShortcutSpec, others: ShortcutSpec[] = []): ValidationResult {
  const { key, modifiers } = spec

  if (!key) return { valid: false, error: 'empty' }

  // 规则 6：总键数上限
  const totalKeys = modifiers.length + 1
  if (totalKeys > MAX_KEYS) return { valid: false, error: 'too_many_keys' }

  // 规则 1：不能只含字母数字（必须带修饰键或使用功能键）
  if (isLetter(key) || isDigit(key)) {
    if (modifiers.length === 0) return { valid: false, error: 'alphanumeric_only' }
  }

  // 规则 2：冲突检测
  if (others.some((o) => sameShortcut(spec, o))) {
    return { valid: false, error: 'already_in_use' }
  }

  // 规则 5：系统保留
  if ([...SYSTEM_RESERVED, ...(process.platform === 'win32' ? WINDOWS_RESERVED : [])].some((r) => sameShortcut(spec, r))) {
    return { valid: false, error: 'system_reserved' }
  }

  // 规则 3/4：连续字母或数字。
  // 只在「多个非修饰键」时才有意义——真实产品的约束是组合键里的字符键不能相邻。
  const charKeys = [key, ...modifiers].filter((k) => isLetter(k) || isDigit(k))
  if (charKeys.length >= 2) {
    const sorted = [...charKeys].sort()
    for (let i = 0; i < sorted.length - 1; i += 1) {
      if (isConsecutive(sorted[i], sorted[i + 1])) {
        return { valid: false, error: isDigit(sorted[i]) ? 'consecutive_numbers' : 'consecutive_letters' }
      }
    }
  }

  return { valid: true }
}

/** 校验一组快捷键（三模式配置），逐项检查且互相冲突。 */
export function validateShortcutSet(specs: ShortcutSpec[]): ValidationResult[] {
  return specs.map((spec, i) => {
    const others = specs.filter((_, j) => j !== i)
    return validateShortcut(spec, others)
  })
}

/** 错误码 → 用户可读文案。 */
export const ERROR_MESSAGES: Record<ValidationError, string> = {
  empty: '请输入快捷键',
  alphanumeric_only: '快捷键不能只包含字母或数字，需配合修饰键',
  already_in_use: '该快捷键已被占用',
  consecutive_letters: '不能使用连续字母',
  consecutive_numbers: '不能使用连续数字',
  system_reserved: '该组合为系统保留，请更换',
  too_many_keys: '快捷键最多包含 3 个键'
}
