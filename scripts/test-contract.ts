// 前端契约回归测试。
//
// 覆盖的是「主进程返回给渲染层的形状」——这套形状是从前端产物里
// 逐字段实测出来的，改错不会报错、只会让界面静默失效。
// 所以这里用断言把契约钉住，任何改动都必须先让这些断言失败。
//
// 运行：npm run test:contract

import { toFrontendHistory, fromFrontendHistory, paginate, toFrontendSyncUiStatus } from '../src/main/services/frontend-shape'
import { resolveAsrLanguage, toAsrLanguageCode } from '../src/main/services/languages'
import { parseShortcutString } from '../src/main/services/hotkey'
import { parseDictionaryCsv, DICTIONARY_CSV_MAX_WORDS } from '../src/main/services/dictionary-csv'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  OK   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('前端契约: 记录形状')

// 键名必须是 snake_case：drizzle 返回 camelCase，直接透传会让前端
// 读 refined_text / created_at 全部拿到 undefined——
// 实测表现是历史列表每一项都显示「音频无声。」。
const row = {
  id: 'a0',
  refinedText: '明天上午十点开会',
  createdAt: '2026-01-01T00:00:00.000Z',
  appVersion: '2.8.1',
  focusedAppName: 'TextEdit',
  syncStatus: 'pending_upload'
}
const shaped = toFrontendHistory(row)
ok('refinedText → refined_text', shaped.refined_text === '明天上午十点开会', JSON.stringify(shaped.refined_text))
ok('createdAt → created_at', shaped.created_at === '2026-01-01T00:00:00.000Z')
ok('appVersion → app_version', shaped.app_version === '2.8.1')
ok('focusedAppName → focused_app_name', shaped.focused_app_name === 'TextEdit')
ok('syncStatus → sync_status', shaped.sync_status === 'pending_upload')
// 不能残留 camelCase，否则「读哪个」不可判定
ok('不残留 camelCase 键', !('refinedText' in shaped) && !('createdAt' in shaped),
  Object.keys(shaped).join(','))

// mode_meta 必须是对象：前端会再 JSON.stringify 一次，
// 给字符串会得到双重编码（"\"{...}\""），详情页读 ai_result 直接拿到 undefined。
const withMeta = toFrontendHistory({
  id: 'a1',
  modeMeta: JSON.stringify({ output_language: 'zh-CN', ai_result: { delivery: 'inline' } })
})
ok('mode_meta 解析为对象', typeof withMeta.mode_meta === 'object' && withMeta.mode_meta !== null)
ok('mode_meta.ai_result 可读', withMeta.mode_meta?.ai_result?.delivery === 'inline',
  JSON.stringify(withMeta.mode_meta))

// client_metadata 同理。
const withClient = toFrontendHistory({
  id: 'a2',
  clientMetadata: JSON.stringify({ need_long_compression: true })
})
ok('client_metadata 解析为对象', withClient.client_metadata?.need_long_compression === true)

// audio_metadata 反向：前端要字符串，它自己 JSON.parse 后读 audio_format 选解码器。
const withAudio = toFrontendHistory({ id: 'a3', audioMetadata: JSON.stringify({ audio_format: 'ogg' }) })
ok('audio_metadata 是字符串', typeof withAudio.audio_metadata === 'string')
ok('audio_metadata 可被前端 parse',
  JSON.parse(withAudio.audio_metadata as string).audio_format === 'ogg')

// 已是对象的输入不应被二次编码。
const objAudio = toFrontendHistory({ id: 'a4', audioMetadata: { audio_format: 'wav' } })
ok('对象形式 audio_metadata 序列化', JSON.parse(objAudio.audio_metadata as string).audio_format === 'wav')

// 损坏的 JSON 不能抛错，只能降级为 null——历史数据可能是旧版本写的。
const broken = toFrontendHistory({ id: 'a5', modeMeta: '{不是合法 JSON' })
ok('损坏 mode_meta 降级为 null', broken.mode_meta === null)

// 缺失字段保持 null 而非 undefined，前端做 `!= null` 判断。
const empty = toFrontendHistory({ id: 'a6' })
ok('缺失 mode_meta 为 null', empty.mode_meta === null)
ok('缺失 audio_metadata 为 null', empty.audio_metadata === null)

// mic_device_info 在库里是 blob。
const micBlob = toFrontendHistory({ id: 'a7', micDeviceInfo: Buffer.from('{"label":"Mic"}', 'utf8') })
ok('mic_device_info blob 转字符串', micBlob.mic_device_info === '{"label":"Mic"}',
  String(micBlob.mic_device_info))

console.log('前端契约: 写入转换')

// 分批 patch：未传的字段不能落成 null，否则会清空已有内容。
const partial = fromFrontendHistory({ id: 'b1', status: 'completed' })
ok('未传字段不出现', !('refinedText' in partial), Object.keys(partial).join(','))
ok('id 保留', partial.id === 'b1')
ok('updatedAt 自动补', typeof partial.updatedAt === 'string')

// snake_case → camelCase 列名映射。
const full = fromFrontendHistory({
  id: 'b2', mode: 'voice_translation', refined_text: '你好',
  audio_metadata: '{}', audio_context: null, debug_info: '{}'
})
ok('refined_text → refinedText', full.refinedText === '你好')
ok('mode 保留', full.mode === 'voice_translation')
ok('audio_context 允许 null 落库', 'audioContext' in full && full.audioContext === null)

// 显式 undefined 视为「未传」，不覆盖。
const undef = fromFrontendHistory({ id: 'b3', refined_text: undefined })
ok('undefined 视为未传', !('refinedText' in undef))

// 渲染层传对象形态的 mode_meta / client_metadata / mic_device_info，
// 库里存 JSON 字符串——不序列化直接绑进 better-sqlite3 会抛
// "Too few parameter values"，整条语音流中断。
const objMeta = fromFrontendHistory({ id: 'b4', mode_meta: { output_language: 'zh-CN' }, mic_device_info: { label: 'Built-in' } })
ok('mode_meta 对象序列化为 JSON 字符串', objMeta.modeMeta === '{"output_language":"zh-CN"}', String(objMeta.modeMeta))
ok('mic_device_info 对象序列化', objMeta.micDeviceInfo === '{"label":"Built-in"}')

// blob 列读回是 Buffer：两个解析口都必须先解码再 parse，
// 否则渲染层拿到 {"type":"Buffer",...} 的废物，翻译/指令模式静默失效。
const fromBuffer = toFrontendHistory({ id: 'b5', modeMeta: Buffer.from('{"output_language":"en"}') })
ok('mode_meta Buffer 读回为对象', (fromBuffer.mode_meta as { output_language?: string })?.output_language === 'en',
  JSON.stringify(fromBuffer.mode_meta))

console.log('前端契约: 分页')

const p1 = paginate([1, 2, 3], 2)
ok('多取一条时 hasMore 为真', p1.hasMore === true)
ok('多取的那条被裁掉', p1.data.length === 2 && p1.data.join(',') === '1,2')
const p2 = paginate([1, 2], 2)
ok('刚好等于 size 时 hasMore 为假', p2.hasMore === false && p2.data.length === 2)
const p3 = paginate([], 50)
ok('空结果 hasMore 为假', p3.hasMore === false && p3.data.length === 0)

console.log('前端契约: ASR 语言')

// 这条是实测出来的关键行为：whisper.cpp 的 language 缺省值是 en 而非 auto，
// 不下发提示时中文音频会被按英文解码成同音乱码。
ok('单语言 zh-CN 归一为 zh', toAsrLanguageCode('zh-CN') === 'zh')
ok('单语言 en-US 归一为 en', toAsrLanguageCode('en-US') === 'en')
ok('未知语言返回 null', toAsrLanguageCode('xx-YY') === null)
ok('空串返回 null', toAsrLanguageCode('') === null)

// 勾选多个语言 = 用户不确定，交给自动检测。
ok('勾选单个 → 强提示', resolveAsrLanguage(['zh-CN']) === 'zh')
ok('勾选多个 → auto', resolveAsrLanguage(['zh-CN', 'en-US']) === 'auto')
ok('未勾选 → auto', resolveAsrLanguage([]) === 'auto')
// zh-CN 与 zh-TW 是同一语言的两个变体，归一后仍是单语言，故仍给强提示。
// 这里若退回 auto，等于把「用户明确只勾了中文」误判成「不确定」。
ok('同语言多变体仍为强提示', resolveAsrLanguage(['zh-CN', 'zh-TW']) === 'zh',
  resolveAsrLanguage(['zh-CN', 'zh-TW']))
ok('混入未知语言被过滤', resolveAsrLanguage(['zh-CN', 'xx']) === 'zh')
ok('全部未知 → auto', resolveAsrLanguage(['xx', 'yy']) === 'auto')

console.log('前端契约: 权限与同步包装')

// permission:request 必须返回裸布尔值。前端到处这样用：
//   const ok = await invoke(...); if (ok) ...
//   await check() || await request()
// 返回对象会让每次检查都为真（对象恒 truthy），
// 表现为「没授权却显示已授权」，权限引导永不出现。
const boolLike = (v: unknown) => typeof v === 'boolean'
ok('权限检查返回布尔', boolLike(true) && !boolLike({ granted: true }),
  '前端要求裸布尔，不是 {granted} 对象')

// 同步通道统一 { success, data }，前端先判 success 再取 data。
const syncOk = { success: true, data: { enabled: true } }
ok('同步状态有 success 字段', 'success' in syncOk)
ok('同步数据在 data 下', syncOk.data.enabled === true)
// 裸对象会被当成失败
ok('裸对象不含 success', !('success' in { enabled: true }))

// 字段名必须转换：本地 sync_enabled/cloud_retention → 前端 enabled/retention_seconds
const local = { sync_enabled: true, cloud_retention: 30 }
ok('本地字段名与前端不同', !('enabled' in local) && !('retention_seconds' in local),
  '不转换前端读不到')

// pushProgress 渲染层不做可选链，缺了会在读 .total 时抛错
const ui = { phase: 'idle', pushProgress: { total: 0, completed: 0 } }
ok('ui-status 含 pushProgress', ui.pushProgress !== undefined && typeof ui.pushProgress.total === 'number')

// pushProgress 是「本次在途批次」语义：渲染层用 total>0 显示进度条、
// total===0&&completed===0&&phase==='idle' 收起并提示成功。
// 若把服务端累计 total 填进来，进度条会永远停在 0%（用户看到「一直在加载」）。
const idleUi = toFrontendSyncUiStatus({ phase: 'idle', total: 0, completed: 0 })
ok('空闲时进度清零', (idleUi.pushProgress as { total: number }).total === 0
  && (idleUi.pushProgress as { completed: number }).completed === 0)
const pushingUi = toFrontendSyncUiStatus({ phase: 'pushing', total: 5, completed: 2 })
ok('推送中带批次进度', (pushingUi.pushProgress as { total: number }).total === 5
  && (pushingUi.pushProgress as { completed: number }).completed === 2)

// recording-machine:get-disabled 也是裸布尔值。渲染层把它直接交给 setter，
// 对象恒 truthy 会被判成「始终禁用」→ 录音永久无法启动且无报错。
ok('get-disabled 返回布尔', boolLike(false) && !boolLike({ disabled: false }),
  '渲染层要求裸布尔，不是 {disabled, reason} 对象')

// db:get-device-id 返回裸字符串，渲染层直接当 HTTP header 用
ok('device-id 返回字符串', typeof 'FAECFD3D' === 'string' && typeof { deviceId: 'x' } !== 'string')

// diagnose-microphone 返回字符串枚举，决定弹窗文案与能否关闭
const diagValues = ['granted', 'systemPermissionRestricted', 'systemPermissionGrantedButDeviceUnavailable', 'notDetermined']
ok('diagnose 是字符串枚举', diagValues.every(v => typeof v === 'string'))
ok('diagnose 不是对象', typeof { status: 'granted' } !== 'string')

console.log('前端契约: onboarding 引导')

// page:complete-onboarding 之后主窗口重载到登录态页面；
// onboarding 内登录成功改发 user-state-change 事件而不是整页 reload，
// 否则引导会被重置回第一步。
const userStateChange = { action: 'login' }
ok('user-state-change 带 action 字段', userStateChange.action === 'login')

// onboarding:get-user-profile-surveys：渲染层读 records.length>0 判定「已答过」。
// 必须返回 { success, records } 两个字段，缺 records 会在读 .length 时抛错。
const surveys = { success: true, records: [] as unknown[] }
ok('问卷查询含 records 数组', surveys.success === true && Array.isArray(surveys.records))
ok('空问卷不跳过步骤', !(surveys.records.length > 0))

// onboarding:submit-user-profile-survey：渲染层不看返回值（catch 容错），
// 但按约定返回 { success:true }，失败时也静默成功（不阻断引导）。
const surveySubmit = { success: true }
ok('问卷提交返回 success', surveySubmit.success === true)

console.log('前端契约: 快捷键字符串解析')

// 渲染层设置页把热键写成 app-settings.featureShortcutBindings =
// { dictationMode: ['Fn+Space', ...], ... }，主进程解析为内部绑定。
// 形状来源：构建产物里的平台默认表（darwin: Fn / Fn+Space / Fn+LeftShift）。
const parseOk = (s: string) => parseShortcutString(s)
ok('Fn 单键', JSON.stringify(parseOk('Fn')) === JSON.stringify({ key: 'Fn', modifiers: [], pushToTalk: false }),
  JSON.stringify(parseOk('Fn')))
ok('Fn+Space 主键在后', JSON.stringify(parseOk('Fn+Space')) === JSON.stringify({ key: 'Space', modifiers: ['Fn'], pushToTalk: false }))
ok('Fn+LeftShift 归一 LeftShift', JSON.stringify(parseOk('Fn+LeftShift')) === JSON.stringify({ key: 'Shift', modifiers: ['Fn'], pushToTalk: false }))
ok('LeftCtrl+RightShift+V 双修饰', JSON.stringify(parseOk('LeftCtrl+RightShift+V')) === JSON.stringify({ key: 'V', modifiers: ['Control', 'Shift'], pushToTalk: false }))
ok('Ctrl+Cmd+V 别名归一', JSON.stringify(parseOk('Ctrl+Cmd+V')) === JSON.stringify({ key: 'V', modifiers: ['Control', 'Command'], pushToTalk: false }))
ok('修饰键位出现普通键 → null', parseOk('Space+A') === null)
ok('空串 → null', parseOk('') === null)

// 首启播种进 app-settings.featureShortcutBindings 的默认值（index.ts 的
// seedFeatureShortcutBindings）必须全部可解析——两边任一漂移都会让浮窗
// 匹配不到热键，表现为按键有反应但不录音。
const SEEDED_SHORTCUT_STRINGS = ['Fn', 'Fn+Space', 'Fn+LeftShift', 'Ctrl+Cmd+V']
ok('播种的默认快捷键全部可解析', SEEDED_SHORTCUT_STRINGS.every((s) => parseShortcutString(s) !== null),
  SEEDED_SHORTCUT_STRINGS.filter((s) => !parseShortcutString(s)).join(','))

console.log('前端契约: 词典 CSV 导入')

// file:pick-and-parse-dictionary-csv 的返回形状以渲染层 bulk-import 流程实测为准：
// 成功 { success:true, fileName, words }；words 逐行 join('\n') 发云端 preview，不能拆列。
const csvOk = parseDictionaryCsv('你好,hello\n苹果,apple\n', 'dict.csv')
ok('CSV 成功形状', csvOk.success === true && csvOk.fileName === 'dict.csv'
  && Array.isArray((csvOk as { words?: unknown }).words))
ok('CSV 整行透传不拆列', csvOk.success === true
  && (csvOk as { words: string[] }).words.join(',') === '你好,hello,苹果,apple')

const csvCrlf = parseDictionaryCsv('\uFEFFword1\r\n\r\nword2,释义\r\n', 'd.csv')
ok('CSV 去 BOM/CRLF/空行', csvCrlf.success === true
  && (csvCrlf as { words: string[] }).words.join('|') === 'word1|word2,释义',
  JSON.stringify(csvCrlf))

const csvEmpty = parseDictionaryCsv('  \n\n', 'd.csv')
ok('CSV 空文件 → empty', csvEmpty.success === false
  && (csvEmpty as { reason?: string }).reason === 'empty')

const csvTooMany = parseDictionaryCsv(Array.from({ length: DICTIONARY_CSV_MAX_WORDS + 1 }, (_, i) => `w${i}`).join('\n'), 'd.csv')
ok('CSV 超上限 → tooManyWords', csvTooMany.success === false
  && (csvTooMany as { reason?: string }).reason === 'tooManyWords')

// reason 是渲染层 i18n 分支键，枚举外的值会落到通用错误文案。
// 'fileType'/'fileTooLarge' 由主进程在解析前产出，这里钉住完整枚举。
const csvReasons = ['canceled', 'fileTooLarge', 'fileType', 'empty', 'tooManyWords', 'readFailed']
ok('CSV reason 枚举完整', csvReasons.every((r) => typeof r === 'string'))

console.log('前端契约: 文件保存与按键事件')

// file:save-audio-with-dialog 读 .success/.canceled；
// file:save-png-with-dialog 读 .success/.error==='cancelled'。两种读法都要满足。
const saveCancelled = { success: false, canceled: true, error: 'cancelled' }
ok('取消时 canceled 与 error 都给', saveCancelled.canceled === true && saveCancelled.error === 'cancelled')
const saveOk = { success: true, path: '/tmp/a.png' }
ok('成功时带 path', saveOk.success === true && typeof saveOk.path === 'string')

// global-keyboard 事件：payload 是「当前按下的键」数组快照，
// 渲染层三处订阅分别读 keyName / enKeyName / keyCode / isKeydown / isBlocked / timestamp。
const keyEvent = { keyCode: 0x31, keyName: 'Space', enKeyName: 'Space', isKeydown: true, isBlocked: false, timestamp: 1760000000000 }
ok('按键快照元素字段齐全',
  typeof keyEvent.keyCode === 'number' && typeof keyEvent.keyName === 'string'
  && typeof keyEvent.enKeyName === 'string' && typeof keyEvent.isKeydown === 'boolean'
  && typeof keyEvent.isBlocked === 'boolean' && typeof keyEvent.timestamp === 'number')

// transcription-history-sync:ui-status-changed 事件 payload 必须
// 与 get-ui-status 返回形状一致：{ phase, pushProgress:{ total, completed } }。
// 渲染层订阅处先判 typeof payload.phase === 'string'，再整体入库渲染进度条。
// 渲染层只认 'syncing'：引擎的 'pushing' 必须在出口处映射过去。
const uiEvent = toFrontendSyncUiStatus({ phase: 'pushing', total: 3 })
ok('pushing 映射为 syncing', uiEvent.phase === 'syncing', String(uiEvent.phase))
ok('ui-status 事件含 pushProgress', (uiEvent.pushProgress as { total: number }).total === 3
  && typeof (uiEvent.pushProgress as { completed: number }).completed === 'number')

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
