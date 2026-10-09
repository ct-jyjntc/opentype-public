// 快捷键校验与音频采集逻辑测试。
// 快捷键校验的六条约束，边界错一条用户就可能配出「按下去打不出字」的热键。

import {
  validateShortcut, validateShortcutSet, ERROR_MESSAGES,
  type ShortcutSpec
} from '../src/main/services/shortcut-validation.ts'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

function v(spec: ShortcutSpec, others: ShortcutSpec[] = []) {
  const r = validateShortcut(spec, others)
  return r.valid ? 'valid' : r.error
}

console.log('\n=== 规则 1：不能只含字母数字 ===')
check('裸字母被拒', v({ key: 'A', modifiers: [] }), 'alphanumeric_only')
check('裸数字被拒', v({ key: '1', modifiers: [] }), 'alphanumeric_only')
check('字母+修饰键通过', v({ key: 'A', modifiers: ['Command'] }), 'valid')
check('功能键无修饰符通过', v({ key: 'F1', modifiers: [] }), 'valid')
check('Space 无修饰符通过', v({ key: 'Space', modifiers: [] }), 'valid')
check('Fn 无修饰符通过', v({ key: 'Fn', modifiers: [] }), 'valid')

console.log('\n=== 规则 2：冲突检测 ===')
{
  const occupied: ShortcutSpec[] = [{ key: 'F1', modifiers: [] }]
  check('重复 F1 被拒', v({ key: 'F1', modifiers: [] }, occupied), 'already_in_use')
  check('不同键通过', v({ key: 'F2', modifiers: [] }, occupied), 'valid')
  // 修饰键顺序不同不应视为不同快捷键
  const cmds: ShortcutSpec[] = [{ key: 'Space', modifiers: ['Command', 'Shift'] }]
  check('修饰键顺序无关', v({ key: 'Space', modifiers: ['Shift', 'Command'] }, cmds), 'already_in_use')
  // 少一个修饰键是不同快捷键
  check('修饰键子集不冲突', v({ key: 'Space', modifiers: ['Command'] }, cmds), 'system_reserved')
}

console.log('\n=== 规则 3/4：禁止连续字母/数字 ===')
check('连续字母被拒', v({ key: 'A', modifiers: ['B', 'Command'] }), 'consecutive_letters')
check('连续数字被拒', v({ key: '1', modifiers: ['2', 'Command'] }), 'consecutive_numbers')
check('非连续字母通过', v({ key: 'A', modifiers: ['C', 'Command'] }), 'valid')
check('非连续数字通过', v({ key: '1', modifiers: ['3', 'Command'] }), 'valid')
// 单个字符键不触发（没有相邻项可比较）
check('单字符键不触发连续规则', v({ key: 'A', modifiers: ['Command'] }), 'valid')

console.log('\n=== 规则 5：系统保留 ===')
check('Cmd+Space 被拒', v({ key: 'Space', modifiers: ['Command'] }), 'system_reserved')
check('Ctrl+Space 被拒', v({ key: 'Space', modifiers: ['Control'] }), 'system_reserved')
check('Cmd+Q 被拒', v({ key: 'Q', modifiers: ['Command'] }), 'system_reserved')
check('Alt+F4 被拒', v({ key: 'F4', modifiers: ['Alt'] }), 'system_reserved')
check('Cmd+Shift+Space 通过（非保留）', v({ key: 'Space', modifiers: ['Command', 'Shift'] }), 'valid')

console.log('\n=== 规则 6：最多 3 个键 ===')
check('3 键通过', v({ key: 'A', modifiers: ['Command', 'Shift'] }), 'valid')
check('4 键被拒', v({ key: 'A', modifiers: ['Command', 'Shift', 'Option'] }), 'too_many_keys')
check('空键被拒', v({ key: '', modifiers: [] }), 'empty')

console.log('\n=== 组合校验（三模式）===')
{
  // 真实默认配置：Fn / Fn+Space / Fn+Shift
  const defaults: ShortcutSpec[] = [
    { key: 'Fn', modifiers: [] },
    { key: 'Space', modifiers: ['Fn'] },
    { key: 'Shift', modifiers: ['Fn'] }
  ]
  const results = validateShortcutSet(defaults)
  check('默认三模式配置全部有效', results.map((r) => r.valid), [true, true, true])
}
{
  // 冲突场景：两个模式配同一个键
  const conflict: ShortcutSpec[] = [
    { key: 'F1', modifiers: [] },
    { key: 'F1', modifiers: [] }
  ]
  const results = validateShortcutSet(conflict)
  check('重复配置被检出', results.map((r) => r.error), ['already_in_use', 'already_in_use'])
}
{
  // 非连续字符键不应误报（F1/F2 是功能键，不算字母）
  const fnKeys: ShortcutSpec[] = [
    { key: 'F1', modifiers: [] },
    { key: 'F2', modifiers: [] }
  ]
  check('F1/F2 不触发连续规则', validateShortcutSet(fnKeys).map((r) => r.valid), [true, true])
}

console.log('\n=== 错误文案完整性 ===')
{
  const codes = ['empty', 'alphanumeric_only', 'already_in_use', 'consecutive_letters',
                 'consecutive_numbers', 'system_reserved', 'too_many_keys']
  check('所有错误码都有文案', codes.every((c) => typeof ERROR_MESSAGES[c] === 'string' && ERROR_MESSAGES[c].length > 0), true)
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
