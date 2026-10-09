// 数据库往返测试。重点验证 camelCase(TS) <-> snake_case(SQL) 映射、
// 以及同步状态机的推进——这两处错了在运行时才炸，且症状隐蔽。

import { initDatabase, HistoryRepo, DictionaryRepo, closeDatabase, type HistoryInsert } from '../src/main/db/index.ts'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

const dbDir = mkdtempSync(join(tmpdir(), 'opentype-test-'))
initDatabase(dbDir)
console.log('=== 数据库往返 ===')

const base: HistoryInsert = {
  id: 'rec-1',
  status: 'completed',
  mode: 'voice_transcript',
  refinedText: '这是润色后的文本',
  duration: 3.5,
  focusedAppName: 'Notion',
  focusedAppBundleId: 'notion.id',
  focusedAppWindowTitle: '产品需求文档',
  focusedAppWebUrl: 'https://www.notion.so/xxx',
  focusedAppWebDomain: 'www.notion.so',
  inputContext: '上一句话在这里',
  modeMeta: JSON.stringify({ delivery: 'insert' }),
  appVersion: '0.1.0',
  syncStatus: 'pending_upload',
  createdAt: new Date('2026-01-01T10:00:00Z').toISOString(),
  updatedAt: new Date('2026-01-01T10:00:00Z').toISOString()
}

await HistoryRepo.upsert(base)

// 读回并逐字段核对映射：属性名用 camelCase，值必须原样落库
const latest = await HistoryRepo.latest()
check('往返: refinedText 映射正确', latest?.refinedText, '这是润色后的文本')
check('往返: focusedAppBundleId 映射正确', latest?.focusedAppBundleId, 'notion.id')
check('往返: focusedAppWindowTitle 映射正确', latest?.focusedAppWindowTitle, '产品需求文档')
check('往返: focusedAppWebDomain 映射正确', latest?.focusedAppWebDomain, 'www.notion.so')
check('往返: inputContext 映射正确', latest?.inputContext, '上一句话在这里')
check('往返: duration 保留小数', latest?.duration, 3.5)
check('往返: syncStatus 默认值', latest?.syncStatus, 'pending_upload')

// 更新走 onConflictDoUpdate 分支，只有指定字段变化，其余保持
await HistoryRepo.upsert({
  ...base,
  refinedText: '改过的文本',
  status: 'completed',
  updatedAt: new Date('2026-01-01T11:00:00Z').toISOString()
})
const afterUpdate = await HistoryRepo.latest()
check('upsert: 文本已更新', afterUpdate?.refinedText, '改过的文本')
check('upsert: 上下文未被覆盖为空', afterUpdate?.focusedAppBundleId, 'notion.id')
check('upsert: 记录数仍为 1', (await HistoryRepo.list()).length, 1)

// 按应用查询
await HistoryRepo.upsert({
  ...base, id: 'rec-2', focusedAppBundleId: 'com.apple.mail',
  refinedText: '邮件内容', createdAt: new Date('2026-01-02T10:00:00Z').toISOString()
})
check('按应用查询: notion 命中 1 条', (await HistoryRepo.byApp('notion.id')).length, 1)
check('按应用查询: mail 命中 1 条', (await HistoryRepo.byApp('com.apple.mail')).length, 1)

// 列表按时间倒序
const list = await HistoryRepo.list()
check('列表: 共 2 条', list.length, 2)
check('列表: 最新在前', list[0].id, 'rec-2')

// 同步状态机：未归属记录也必须能被认领并进入同步队列（离线试用 -> 登录场景）
// rec-1 与 rec-2 都是离线录制（user_id 为 null），两者都应进入候选集
check('同步: 未归属记录可进入候选集', (await HistoryRepo.pendingSync('user-1')).length, 2)
check('认领: 两条无归属记录被认领', await HistoryRepo.claimOrphans('user-1'), 2)
check('认领: 重复认领为 0 条', await HistoryRepo.claimOrphans('user-1'), 0)
check('认领: 已归属且待同步', (await HistoryRepo.pendingSync('user-1')).length, 2)
check('认领: 记录归属已写入', (await HistoryRepo.list()).every((r) => r.userId === 'user-1'), true)
await HistoryRepo.markSynced(['rec-1'])
const synced = (await HistoryRepo.list()).find((r) => r.id === 'rec-1')
check('同步: 标记为 synced', synced?.syncStatus, 'synced')

// 同步失败：次数递增，供上层做指数退避
await HistoryRepo.markSyncFailed(['rec-2'])
const failedRec = (await HistoryRepo.list()).find((r) => r.id === 'rec-2')
check('同步失败: 状态为 sync_failed', failedRec?.syncStatus, 'sync_failed')
check('同步失败: 次数 +1', failedRec?.syncAttemptCount, 1)
await HistoryRepo.markSyncFailed(['rec-2'])
check('同步失败: 次数再 +1', (await HistoryRepo.list()).find((r) => r.id === 'rec-2')?.syncAttemptCount, 2)

// 空数组不应触发 SQL 语法错误
await HistoryRepo.markSynced([])
await HistoryRepo.markSyncFailed([])
check('同步: 空数组不抛异常', true, true)

// 未完成/空文本的记录不应进入同步候选集
await HistoryRepo.upsert({
  ...base, id: 'rec-3', status: 'failed', refinedText: null,
  syncStatus: 'pending_upload', createdAt: new Date('2026-01-03T10:00:00Z').toISOString()
})
const pending = await HistoryRepo.pendingSync('user-1')
check('同步候选: 排除 failed 记录', pending.some((r) => r.id === 'rec-3'), false)

// 删除与清理
await HistoryRepo.remove('rec-2')
// rec-2 刚被删除，此刻库内为 rec-1 与 rec-3（rec-4 尚未插入）
check('删除: 剩 2 条', (await HistoryRepo.list()).length, 2)
const purged = await HistoryRepo.purgeOlderThan(1)   // 1 天保留期，1 月的记录全过期
check('清理: 过期记录被删除', purged > 0, true)
check('清理: 已清空', (await HistoryRepo.list()).length, 0)

// 补齐的字段必须真正落库（否则 schema 与建表语句脱节）
await HistoryRepo.upsert({
  ...base, id: 'rec-4',
  editedText: '用户改过的文本',
  editedTextStatus: 'EXTRACTED',
  editedTextAttempts: 2,
  hasRevertedAi: true,
  axText: '辅助功能读到的原文',
  axHtml: '<p>富文本</p>',
  languages: 'en,zh',
  detectedLanguage: 'zh',
  micDeviceInfo: Buffer.from('device-info'),
  createdAt: new Date('2026-01-04T10:00:00Z').toISOString()
})
const r4 = (await HistoryRepo.list()).find((r) => r.id === 'rec-4')
check('字段: editedText 落库', r4?.editedText, '用户改过的文本')
check('字段: editedTextStatus 落库', r4?.editedTextStatus, 'EXTRACTED')
check('字段: editedTextAttempts 落库', r4?.editedTextAttempts, 2)
check('字段: hasRevertedAi 落库', r4?.hasRevertedAi, true)
check('字段: axText 落库', r4?.axText, '辅助功能读到的原文')
check('字段: detectedLanguage 落库', r4?.detectedLanguage, 'zh')
check('字段: languages 落库', r4?.languages, 'en,zh')
check('字段: micDeviceInfo(blob) 落库', r4?.micDeviceInfo ? 'has-data' : 'empty', 'has-data')

// 关键：pendingSyncForApi 必须把 drizzle 的 camelCase 转成服务端期望的 snake_case。
// 不做转换会让服务端读到 undefined，表现为「推送成功但云端为空」。
{
  const rows = await HistoryRepo.pendingSyncForApi('user-1', 10)
  // 取实际存在的待推送记录（前面的用例已删除部分记录）
  const r = rows[0]
  check('API 转换: 有待推送记录', rows.length > 0, true)
  check('API 转换: refined_text 字段名', r?.refined_text !== undefined, true)
  check('API 转换: 不含 camelCase refinedText', r?.refinedText, undefined)
  check('API 转换: 不含 camelCase createdAt', r?.createdAt, undefined)
  check('API 转换: created_at 字段名', typeof r?.created_at === 'string', true)
  check('API 转换: id 保留', typeof r?.id === 'string', true)
  // userId 为 NULL 的孤儿记录也应被认领（这是 claimOrphans 的场景）
  const all = await HistoryRepo.list()
  const orphans = all.filter((x) => x.userId === null)
  check('API 转换: 孤儿记录可被推送', orphans.length === 0 || rows.length > 0, true)
}

// 过滤规则的第二个分支：voice_command + delivery=external，即使文本为空也要推送。
// 只筛「文本非空」会让这类记录永远不推送——这是推送候选集过滤的关键点。
{
  await HistoryRepo.upsert({
    ...base, id: 'cmd-external', userId: 'user-1', status: 'completed',
    mode: 'voice_command', refinedText: '',
    modeMeta: JSON.stringify({ ai_result: { delivery: 'external' } }),
    createdAt: new Date('2026-01-05T10:00:00Z').toISOString()
  })
  await HistoryRepo.upsert({
    ...base, id: 'cmd-inline', userId: 'user-1', status: 'completed',
    mode: 'voice_command', refinedText: '',
    modeMeta: JSON.stringify({ ai_result: { delivery: 'inline' } }),
    createdAt: new Date('2026-01-05T10:01:00Z').toISOString()
  })

  const rows = await HistoryRepo.pendingSyncForApi('user-1', 50)
  const ids = rows.map((r) => r.id)
  check('过滤规则: 空文本+external 被推送', ids.includes('cmd-external'), true)
  check('过滤规则: 空文本+inline 被过滤', ids.includes('cmd-inline'), false)
}

// 词条
await DictionaryRepo.add('user-1', 'Kubernetes', 'k8s')
await DictionaryRepo.add('user-1', 'Kubernetes', 'k8s')   // 重复添加应被唯一索引吞掉
check('词条: 去重后 1 条', (await DictionaryRepo.list('user-1')).length, 1)

// Editable frontend searches all history, not merely the first page.
await HistoryRepo.upsert({...base,id:'editable-search',mode:'voice_translation',refinedText:'unique frontend phrase',duration:2})
check('Search: matches text and mode', (await HistoryRepo.search('frontend','voice_translation',0,10)).length, 1)
check('Search: mismatched mode excluded', (await HistoryRepo.search('frontend','voice_command',0,10)).length, 0)
await HistoryRepo.upsert({id:'editable-search',editedText:'edited phrase'})
check('Search: user edits indexed', (await HistoryRepo.search('edited phrase','',0,10)).length, 1)
check('Retention: forever never purges', await HistoryRepo.purgeOlderThan(-1), 0)
check('Stats: totals include records', (await HistoryRepo.stats()).count > 0, true)
const term=(await DictionaryRepo.list('user-1'))[0]
await DictionaryRepo.update('other-user',term.id,'wrong','')
check('Dictionary: another user cannot edit', (await DictionaryRepo.list('user-1'))[0].term, 'Kubernetes')
await DictionaryRepo.update('user-1',term.id,'OpenType','open type')
check('Dictionary: edit persisted', (await DictionaryRepo.list('user-1'))[0].term, 'OpenType')
await DictionaryRepo.remove('other-user',term.id)
check('Dictionary: another user cannot delete', (await DictionaryRepo.list('user-1')).length, 1)
await DictionaryRepo.remove('user-1',term.id)
check('Dictionary: delete persisted', (await DictionaryRepo.list('user-1')).length, 0)

closeDatabase()
rmSync(dbDir, { recursive: true, force: true })
check('清理: 临时目录已删除', existsSync(dbDir), false)

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
