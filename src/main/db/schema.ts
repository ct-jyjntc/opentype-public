// 本地数据模型。设计要点：
// 1. 录音与转写记录本地优先，离线也能查看历史；云端同步是可选增量。
// 2. sync_* 三件套（状态/次数/时间戳）构成断点续传的基础，避免弱网下丢记录。
// 3. 上下文（focused_app_*）单独成列并建复合索引，支撑「按应用查历史」这个高频场景。

import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const history = sqliteTable('history', {
  id: text('id').primaryKey(),

  // 归属与状态
  userId: text('user_id'),
  cloudScope: text('cloud_scope'),
  status: text('status').$type<HistoryStatus>().default('pending'),
  mode: text('mode').$type<CaptureMode>().default('voice_transcript').notNull(),

  // 结果文本：refinedText 是 AI 润色后的最终稿
  refinedText: text('refined_text'),

  // 用户手动修改后的文本与其提取状态机。
  // NOT_EXTRACTED -> 待提取；用于学习用户的编辑习惯（个性化写作风格的数据来源）
  editedText: text('edited_text'),
  editedTextStatus: text('edited_text_status').default('NOT_EXTRACTED').notNull(),
  editedTextAttempts: integer('edited_text_attempts').default(0).notNull(),

  // 是否回退过 AI 润色（用户按 deleteBackward 撤销）
  hasRevertedAi: integer('has_reverted_ai', { mode: 'boolean' }),

  // 采集到的辅助功能原始内容。仅调试与问题诊断使用，不参与同步
  axText: text('ax_text'),
  axHtml: text('ax_html'),

  // 语言：用户指定 + 服务端检测结果
  languages: text('languages'),
  detectedLanguage: text('detected_language'),

  // 音频
  duration: real('duration'),
  audioLocalPath: text('audio_local_path'),
  audioMetadata: text('audio_metadata'),
  micDevice: text('mic_device'),
  /** 麦克风设备详情（label / groupId / transportType），blob 存储 */
  micDeviceInfo: blob('mic_device_info'),

  // 上下文快照：注入位置的应用与页面，用于回溯「这句话当时是写给谁的」
  focusedAppName: text('focused_app_name'),
  focusedAppBundleId: text('focused_app_bundle_id'),
  focusedAppWindowTitle: text('focused_app_window_title'),
  focusedAppWebUrl: text('focused_app_web_url'),
  focusedAppWebDomain: text('focused_app_web_domain'),
  inputContext: text('input_context'),

  // 模式附加信息：voice_command 的 delivery 结果、voice_translation 的目标语言等。
  // 真实产品用 blob（drizzle 快照确认），因为内容含嵌套结构且不参与 SQL 查询
  modeMeta: blob('mode_meta'),

  // 版本与调试
  appVersion: text('app_version').default('0.0.0').notNull(),
  debugInfo: text('debug_info'),

  // 加密后的上下文 JSON。用于「结合输入框内容」的润色。
  audioContext: text('audio_context'),
  clientMetadata: text('client_metadata'),

  // 同步状态机
  syncStatus: text('sync_status').$type<SyncStatus>().default('pending_upload').notNull(),
  syncAttemptCount: integer('sync_attempt_count').default(0).notNull(),
  serverUpdatedAt: integer('server_updated_at'),
  syncedFromCloud: integer('synced_from_cloud', { mode: 'boolean' }).default(false).notNull(),

  createdAt: text('created_at'),
  updatedAt: text('updated_at')
}, (t) => ({
  idUnique: uniqueIndex('history_id_unique').on(t.id),
  userCreated: index('idx_history_user_created').on(t.userId, t.createdAt),
  statusIdx: index('idx_history_status').on(t.status),
  // 按应用 + 时间查询历史（设置页「这个应用里我说过什么」）
  userAppStatusCreated: index('idx_history_user_app_status_created')
    .on(t.userId, t.focusedAppBundleId, t.status, t.createdAt),
  // 同步候选集：只挑已完成且确有内容的记录推送，减少无意义的网络往返
  pushCandidate: index('idx_history_push_candidate')
    .on(t.userId, t.syncStatus, t.createdAt, t.syncAttemptCount)
}))

export const dictionary = sqliteTable('dictionary', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  // 自定义词条：纠正 ASR 对专有名词的误识别，是专业场景可用性的关键
  term: text('term').notNull(),
  pronunciation: text('pronunciation'),
  sourceHistoryId: text('source_history_id').references(() => history.id, { onDelete: 'set null' }),
  sourceKind: text('source_kind').$type<'history_edit' | 'input_edit'>(),
  createdAt: text('created_at')
}, (t) => ({
  userTerm: uniqueIndex('dictionary_user_term_unique').on(t.userId, t.term)
}))

/** Local deletion survives restart and prevents an old sync/retry from restoring text. */
export const historyTombstones = sqliteTable('history_tombstones', {
  id: text('id').primaryKey(),
  deletedAt: text('deleted_at').notNull(),
  audioPending: integer('audio_pending', { mode: 'boolean' }).default(true).notNull(),
})

export type HistoryStatus = 'pending' | 'transcribing' | 'refining' | 'completed' | 'failed' | 'cancelled'
export type CaptureMode = 'voice_transcript' | 'voice_command' | 'voice_translation'
export type SyncStatus = 'pending_upload' | 'syncing' | 'synced' | 'sync_failed'
