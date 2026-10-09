// 本地记录 ↔ 渲染层期望形状的转换。
//
// 为什么单独成模块：这套转换的每一处类型选择都是从前端混淆产物里实测出来的，
// 错一处不会报错、只会让界面静默失效（详情页空白、同步丢字段）。
// 抽出来才能被测试直接覆盖，而不是只能靠手点界面发现。
//
// 三条实测结论（来源：frontend/renderer/static/js/）：
// 1. mode_meta / client_metadata —— 库里是 JSON 字符串，前端要**对象**
//    （前端会再 JSON.stringify 一次，给字符串会得到双重编码的垃圾）。
// 2. audio_metadata —— 反过来，前端要**字符串**，它自己 JSON.parse
//    并读取 audio_format 字段来选解码器。
// 3. 字段名一律 snake_case —— 前端按列名直接访问，不做驼峰转换。

/** 前端传入的字段名 → 数据库列名（drizzle 属性名）。 */
const FRONTEND_TO_COLUMN: Record<string, string> = {
  mode: 'mode',
  status: 'status',
  refined_text: 'refinedText',
  duration: 'duration',
  audio_metadata: 'audioMetadata',
  audio_context: 'audioContext',
  debug_info: 'debugInfo',
  mic_device: 'micDevice',
  mic_device_info: 'micDeviceInfo',
  mode_meta: 'modeMeta',
  client_metadata: 'clientMetadata'
}

/**
 * 数据库列名（drizzle camelCase）→ 前端读取的 snake_case 字段名。
 *
 * 不能靠 `...row` 直接透传：drizzle 返回的是 camelCase 属性名，
 * 而前端按列名访问（history.refined_text / created_at / app_version）。
 * 少了这一步，前端读到的全是 undefined——实测表现是历史列表
 * 每一项都显示「音频无声。」，因为 refined_text 取不到。
 */
const COLUMN_TO_FRONTEND: Record<string, string> = {
  id: 'id',
  userId: 'user_id',
  status: 'status',
  mode: 'mode',
  refinedText: 'refined_text',
  editedText: 'edited_text',
  editedTextStatus: 'edited_text_status',
  editedTextAttempts: 'edited_text_attempts',
  hasRevertedAi: 'has_reverted_ai',
  axText: 'ax_text',
  axHtml: 'ax_html',
  languages: 'languages',
  detectedLanguage: 'detected_language',
  duration: 'duration',
  audioLocalPath: 'audio_local_path',
  audioMetadata: 'audio_metadata',
  micDevice: 'mic_device',
  micDeviceInfo: 'mic_device_info',
  focusedAppName: 'focused_app_name',
  focusedAppBundleId: 'focused_app_bundle_id',
  focusedAppWindowTitle: 'focused_app_window_title',
  focusedAppWebUrl: 'focused_app_web_url',
  focusedAppWebDomain: 'focused_app_web_domain',
  inputContext: 'input_context',
  modeMeta: 'mode_meta',
  appVersion: 'app_version',
  debugInfo: 'debug_info',
  audioContext: 'audio_context',
  clientMetadata: 'client_metadata',
  syncStatus: 'sync_status',
  syncAttemptCount: 'sync_attempt_count',
  serverUpdatedAt: 'server_updated_at',
  syncedFromCloud: 'synced_from_cloud',
  createdAt: 'created_at',
  updatedAt: 'updated_at'
}

/** 解析库里以 JSON 字符串形式存储的字段。损坏或为空时返回 null。 */
function parseOrNull(value: unknown): unknown {
  if (value === null || value === undefined) return null
  // drizzle 的 blob 列读出来是 Buffer——内容是 JSON 字符串，必须先解码再 parse，
  // 否则 IPC 序列化后前端拿到的是 {"type":"Buffer","data":[...]} 的废物。
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value)
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/** 序列化成前端要的字符串形式；已是字符串则原样返回。 */
function asJsonString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * 本地记录 → 前端形状。
 *
 * 做两件事：
 * 1. 键名 camelCase → snake_case（前端按列名访问）。
 * 2. 修正三处类型：mode_meta / client_metadata 转对象、audio_metadata 转字符串。
 *
 * 注意不能保留 camelCase 原字段：前端对同一字段的两种命名不会都读，
 * 留着只会让「到底读哪个」变得不可判定。
 */
export function toFrontendHistory(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [column, frontendKey] of Object.entries(COLUMN_TO_FRONTEND)) {
    if (column in row) out[frontendKey] = row[column]
  }
  // 未登记在映射表里的字段原样透传，避免以后新增列被静默丢掉
  for (const [k, v] of Object.entries(row)) {
    if (!(k in COLUMN_TO_FRONTEND) && !(k in out)) out[k] = v
  }

  out.mode_meta = parseOrNull(row.modeMeta)
  out.client_metadata = parseOrNull(row.clientMetadata)
  out.audio_metadata = asJsonString(row.audioMetadata)
  const micInfo = row.micDeviceInfo
  out.mic_device_info = micInfo instanceof Uint8Array
    ? Buffer.from(micInfo).toString('utf8')
    : (micInfo ?? null)
  return out
}

/**
 * 前端记录 → 数据库列。
 *
 * 前端是分批 patch 写入的（先建占位记录，再补上下文、模式、状态），
 * 所以未传的字段必须保持 undefined 而不是落成 null——
 * 否则后一次 patch 会把前一次写入的内容清空。
 */
export function fromFrontendHistory(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [frontendKey, column] of Object.entries(FRONTEND_TO_COLUMN)) {
    if (frontendKey in record && record[frontendKey] !== undefined) {
      // 库里 mode_meta / mic_device_info 等列存 JSON 字符串（pipeline 写入也是
      // JSON.stringify）。前端传来的是对象，直接绑进 better-sqlite3 会抛
      // "Too few parameter values"，整个语音流随之中断——这里统一序列化。
      const value = record[frontendKey]
      out[column] = isPlainObjectOrArray(value) ? JSON.stringify(value) : value
    }
  }
  const now = new Date().toISOString()
  out.id = String(record.id ?? '')
  out.updatedAt = now
  out.createdAt = now
  // 未显式给状态时按「进行中」处理，前端随后会用 status 覆盖
  if (!out.status) out.status = 'pending'
  return out
}

/** 可 JSON 序列化的普通对象/数组（排除 Buffer/Uint8Array 等二进制形态）。 */
function isPlainObjectOrArray(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return false
  if (v instanceof ArrayBuffer) return false
  return true
}

/** 分页包装：多取一条判断 hasMore，省掉一次 count 查询。 */
export function paginate<T>(rows: T[], size: number): { data: T[]; hasMore: boolean } {
  const hasMore = rows.length > size
  return { data: hasMore ? rows.slice(0, size) : rows, hasMore }
}

/**
 * 同步 UI 状态转换。
 *
 * 前端读 phase 与 pushProgress.total/completed 来渲染进度条，
 * 缺了 pushProgress 会在读取 .total 时抛错（前端未做可选链）。
 *
 * phase 的语义：'syncing' 表示正在推送，前端据此显示加载态。
 * 本地引擎没有在途任务时即为 'idle'。
 *
 * 这条转换同时服务两个出口（形状必须一致）：
 * - sync-engine:transcription-history:get-ui-status 的返回值
 * - 主进程推送的 transcription-history-sync:ui-status-changed 事件 payload
 */
export function toFrontendSyncUiStatus(s: unknown): Record<string, unknown> {
  const v = (s ?? {}) as Record<string, unknown>
  return {
    // 渲染层只认 'syncing'（产物里没有 'pushing' 这个词）——不映射的话
    // 同步弹窗的「见过 syncing」标志永远不会置位，弹窗永不自动关闭。
    phase: v.phase === 'pushing' ? 'syncing' : (v.phase ?? 'idle'),
    pushProgress: {
      total: Number(v.total ?? 0),
      // 没有独立的在途计数，用「已推送条数」近似——前端只拿它判断是否 >0
      completed: Number(v.completed ?? 0)
    }
  }
}
