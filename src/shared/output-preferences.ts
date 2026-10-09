export type ExpressionStyle = 'original' | 'concise' | 'formal' | 'casual'
export interface OutputPreferences {
  punctuation: 'preserve' | 'chinese'
  spacing: 'preserve' | 'space' | 'compact'
  expression: ExpressionStyle
}
export interface WritingApp { bundleId: string; appName: string }
export interface AppExpression extends WritingApp { expression: ExpressionStyle }

export const DEFAULT_OUTPUT: OutputPreferences = {
  punctuation: 'preserve', spacing: 'preserve', expression: 'original',
}
export const EXPRESSIONS: [ExpressionStyle, string][] = [
  ['original', '保持原语气'], ['concise', '简洁'], ['formal', '正式'], ['casual', '自然口语'],
]
export const COMMON_WRITING_APPS: WritingApp[] = [
  { bundleId: 'com.tencent.xinWeChat', appName: '微信' },
  { bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' },
  { bundleId: 'com.apple.mail', appName: '邮件' },
  { bundleId: 'com.apple.Notes', appName: '备忘录' },
  { bundleId: 'com.microsoft.VSCode', appName: 'Visual Studio Code' },
  { bundleId: 'com.apple.Safari', appName: 'Safari' },
  { bundleId: 'com.google.Chrome', appName: 'Google Chrome' },
]
const isExpression = (v: unknown): v is ExpressionStyle => EXPRESSIONS.some(([key]) => key === v)

/** Tolerate old stores on read; reject invalid renderer writes as a whole. */
export function readOutputPreferences(value: unknown, strict = false): OutputPreferences {
  const v = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const valid = ['preserve', 'chinese'].includes(String(v.punctuation))
    && ['preserve', 'space', 'compact'].includes(String(v.spacing)) && isExpression(v.expression)
  if (strict && !valid) throw new Error('invalid_output_preferences')
  return {
    punctuation: v.punctuation === 'chinese' ? 'chinese' : 'preserve',
    spacing: v.spacing === 'space' || v.spacing === 'compact' ? v.spacing : 'preserve',
    expression: isExpression(v.expression) ? v.expression : 'original',
  }
}
export function readAppExpressions(value: unknown, strict = false): AppExpression[] {
  if (!Array.isArray(value) || value.length > 50) {
    if (strict) throw new Error('invalid_app_expression')
    return []
  }
  const seen = new Set<string>(), result: AppExpression[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object' || typeof v.bundleId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(v.bundleId)
      || typeof v.appName !== 'string' || !v.appName.trim() || v.appName.length > 120
      || !isExpression(v.expression) || seen.has(v.bundleId)) {
      if (strict) throw new Error('invalid_app_expression')
      continue
    }
    seen.add(v.bundleId)
    result.push({ bundleId: v.bundleId, appName: v.appName.trim(), expression: v.expression })
  }
  return result
}
export function resolveOutputPreferences(
  preferences: { outputPreferences: OutputPreferences; appExpressions: AppExpression[] }, bundleId: string,
): OutputPreferences {
  return { ...preferences.outputPreferences,
    expression: preferences.appExpressions.find(rule => rule.bundleId === bundleId)?.expression
      ?? preferences.outputPreferences.expression }
}
