import assert from 'node:assert/strict'
import { DEFAULT_OUTPUT, readAppExpressions, readOutputPreferences, resolveOutputPreferences } from '../src/shared/output-preferences'
import { applyOutputPreferences, formatDictation } from '../src/main/services/output-format'
import type { TranscribeParams } from '../src/main/services/providers/types'
const formatted = { punctuation: 'chinese', spacing: 'space', expression: 'original' } as const
let count = 0
function test(name: string, fn: () => void) { fn(); count++; console.log('OK ' + name) }
test('old and malformed stores default safely, strict writes reject whole invalid payloads', () => {
  assert.deepEqual(readOutputPreferences(undefined), DEFAULT_OUTPUT)
  assert.deepEqual(readAppExpressions(null), [])
  for (const value of [null, [], {}, { ...formatted, spacing: 'invalid' }]) assert.throws(() => readOutputPreferences(value, true), /invalid_output_preferences/)
  const app = { bundleId: 'test.mail', appName: 'Mail', expression: 'formal' }
  assert.deepEqual(readAppExpressions([app, { ...app, expression: 'casual' }]), [app])
  for (const value of [[app, app], [{ ...app, bundleId: '../x' }], [{ ...app, appName: '' }], [{ ...app, expression: 'invent' }], Array(51).fill(app)])
    assert.throws(() => readAppExpressions(value, true), /invalid_app_expression/)
})
test('exact bundle match wins over global style; names and near matches do not match', () => {
  const p = { outputPreferences: { ...formatted, expression: 'concise' as const }, appExpressions: [{ bundleId: 'test.mail', appName: '邮件', expression: 'formal' as const }] }
  assert.equal(resolveOutputPreferences(p, 'test.mail').expression, 'formal')
  assert.equal(resolveOutputPreferences(p, 'test.mail.other').expression, 'concise')
  assert.equal(resolveOutputPreferences(p, '邮件').expression, 'concise')
  assert.equal(resolveOutputPreferences(p, '').expression, 'concise')
  assert.equal(p.outputPreferences.expression, 'concise')
})
test('Chinese punctuation and Han-English spacing are independent and opt-in', () => {
  const text = '今天用OpenType写3封邮件,明天复核.价格是8.5折,不是85折!'
  assert.equal(formatDictation(text, DEFAULT_OUTPUT), text)
  assert.equal(formatDictation(text, formatted), '今天用 OpenType 写 3 封邮件，明天复核。价格是 8.5 折，不是 85 折！')
  assert.equal(formatDictation('中文 API 和 3 个词', { ...formatted, spacing: 'compact' }), '中文API和3个词')
  assert.equal(formatDictation('中文API,很好.', { ...formatted, spacing: 'preserve' }), '中文API，很好。')
  assert.equal(formatDictation('中文API,很好.', { ...formatted, punctuation: 'preserve' }), '中文 API,很好.')
})
test('decimals, versions, percentages, times, thousand separators and English punctuation retain values', () => {
  assert.equal(formatDictation('3.14，8.5折，85折，1,234.50元，12:30，v0.2.0-beta.9，-3.5%，A/B，C++', formatted), '3.14，8.5 折，85 折，1,234.50 元，12:30，v0.2.0-beta.9，-3.5%，A/B，C++')
  const english = 'Hello, world! It costs 8.5 dollars; is version v1.2.3 ready?'
  assert.equal(formatDictation(english, formatted), english)
})
test('URLs, emails, Unicode paths, filenames, Markdown targets and inline code are preserved', () => {
  const tokens = ['https://example.com/中文API?q=1,2#中文', 'me@example.com', '/Users/test/中文API.ts', 'C:\\项目\\中文ABC.txt', '中文API.txt', '[中文API](https://test.invalid/a?q=2)', '`中文ABC,foo()`', '"中文ABC,内容"']
  for (const token of tokens) assert.equal(formatDictation('保留：' + token + '；完成。', formatted), '保留：' + token + '；完成。')
})
test('fenced, unclosed, indented and obvious code lines are preserved alongside surrounding prose', () => {
  const code = '```ts\r\nconst 名称 = "中文ABC";\r\nprint(中文ABC, 123)\r\n```'
  assert.equal(formatDictation('中文API,好.\r\n' + code + '\r\n继续ABC', formatted), '中文 API，好。\r\n' + code + '\r\n继续 ABC')
  for (const code of ['```\n中文ABC,测试', '~~~~js\n中文ABC\n~~~~', 'const x = 中文ABC;', '{"value":"中文ABC"}', '<div>中文ABC</div>', 'name: 中文ABC', '    中文ABC,代码']) {
    assert.equal(formatDictation(code, formatted), code)
  }
})
test('line breaks, emoji and characters survive; formatting is idempotent for both spacing choices', () => {
  for (const spacing of ['space', 'compact'] as const) {
    const text = '今天OpenType测试🙂!\n预算1,234.50元\r\n访问https://example.com/abc\n下一项API'
    const once = formatDictation(text, { ...formatted, spacing })
    assert.equal(formatDictation(once, { ...formatted, spacing }), once)
    assert.equal(once.replace(/[\s,，.。!！]/g, ''), text.replace(/[\s,，.。!！]/g, ''))
  }
})
test('only successful ordinary local delivery changes; original result and raw text are retained', () => {
  const params: TranscribeParams = { mode: 'voice_transcript', audio: new Uint8Array(), audioId: 'test', duration: 0, audioContext: {}, audioMetadata: {}, parameters: { output_preferences: formatted } }
  const input = { success: true, text: '中文ABC,好.', rawText: '识别原文' }
  assert.equal(applyOutputPreferences(input, params).text, '中文 ABC，好。')
  assert.equal(applyOutputPreferences(input, params).rawText, '识别原文')
  assert.equal(input.text, '中文ABC,好.')
  assert.equal(applyOutputPreferences({ ...input, rawText: undefined }, params).rawText, input.text)
  for (const mode of ['voice_command', 'voice_translation'] as const) assert.equal(applyOutputPreferences(input, { ...params, mode }), input)
  for (const result of [{ ...input, success: false }, { ...input, delivery: 'external' }]) assert.equal(applyOutputPreferences(result, params), result)
})
console.log(`${count} output preference scenarios passed`)
