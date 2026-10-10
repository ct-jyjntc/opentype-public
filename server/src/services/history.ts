// 历史同步服务。
//
// 同步协议 /transcription_history/* 系列：
// - push        增量上传，返回已接受的 id
// - pull        按 server_updated_at 游标增量拉取
// - load_older  向历史方向翻页（backfill）
// - wipe        清空云端
// - sync_status 同步状态与计数
// - sync_settings 保留期设置
//
// Live updates use server arrival order. Explicit deletion always wins over a stale upload.

import { getDb, transaction } from '../db/index.ts'

/** 单批推送上限。 */
export const MAX_PUSH_BATCH = 200

/** 分页大小。 */
export const PAGE_SIZE = 50

export interface HistoryRecord {
  id: string
  status?: string
  mode?: string
  refined_text?: string
  duration?: number
  created_at?: string
  updated_at?: string
  audio_local_path?: string
  audio_metadata?: string
  app_version?: string
  mic_device?: string
  mic_device_info?: unknown
  client_metadata?: unknown
  mode_meta?: unknown
  debug_info?: string
  audio_context?: string
}

export interface PushResult {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
  server_updated_at: number
}

/**
 * 判断记录是否值得同步。
 *
 * 推送候选集过滤规则：
 * 只有「已成功转写且文本非空」或「语音命令且触发了外部动作」才同步。
 * 空转写、失败记录都不该占用同步流量。
 */
function isSyncCandidate(record: HistoryRecord): boolean {
  if (record.status !== 'completed') return false
  if (record.refined_text && record.refined_text.trim() !== '') return true

  // voice_command 且服务端返回了 delivery: 'external'（触发了外部动作）
  if (record.mode === 'voice_command' && record.mode_meta) {
    try {
      const meta = typeof record.mode_meta === 'string' ? JSON.parse(record.mode_meta) : record.mode_meta
      return meta?.ai_result?.delivery === 'external'
    } catch {
      return false
    }
  }
  return false
}

const STRING_FIELDS = [
  'status', 'mode', 'refined_text', 'created_at', 'updated_at', 'audio_local_path',
  'audio_metadata', 'app_version', 'mic_device', 'debug_info', 'audio_context'
] as const

/** 字段类型校验在事务前完成：一条畸形记录只拒绝它自己，不让整批 500。 */
function invalidField(record: HistoryRecord): string | null {
  const r = record as unknown as Record<string, unknown>
  for (const name of STRING_FIELDS) {
    if (r[name] !== undefined && r[name] !== null && typeof r[name] !== 'string') return name
  }
  if (r.duration !== undefined && r.duration !== null && (typeof r.duration !== 'number' || !Number.isFinite(r.duration))) return 'duration'
  return null
}

/** 把 unknown 转成可存入 SQLite 的值。BLOB 列接受 Buffer 或 null。 */
function toBlob(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function latestChange(userId: string): number {
  return Number((getDb().prepare(`SELECT COALESCE(MAX(server_updated_at), 0) AS value FROM (
    SELECT server_updated_at FROM history WHERE user_id = ?
    UNION ALL SELECT server_updated_at FROM history_deletions WHERE user_id = ?
    UNION ALL SELECT server_updated_at FROM history_cloud_evictions WHERE user_id = ?
  )`).get(userId, userId, userId) as { value: number }).value)
}

/** Idempotent even if the upload has not arrived. The authenticated account owns the namespace. */
export function deleteHistory(userId: string, ids: string[]) {
  const db = getDb()
  return transaction(() => {
    let cursor = Math.max(Date.now(), latestChange(userId))
    const insert = db.prepare('INSERT OR IGNORE INTO history_deletions (id, user_id, server_updated_at) VALUES (?, ?, ?)')
    const remove = db.prepare('DELETE FROM history WHERE id = ? AND user_id = ?')
    const accepted = [...new Set(ids)]
    for (const id of accepted) {
      insert.run(id, userId, ++cursor)
      remove.run(id, userId)
      db.prepare('DELETE FROM history_cloud_evictions WHERE user_id = ? AND id = ?').run(userId, id)
    }
    return { accepted, server_updated_at: latestChange(userId) }
  })
}

export function pushHistory(userId: string, records: HistoryRecord[], epoch?: number): PushResult {
  const db = getDb()
  const now = Date.now()
  expireCloudHistory(userId, now)
  if ((epoch ?? 0) !== cloudEpoch(userId)) throw new Error('cloud_epoch_changed')
  let updatedAt = Math.max(now, latestChange(userId))

  if (!Array.isArray(records)) return { accepted: [], rejected: [], server_updated_at: now }
  if (!isSyncEnabled(userId)) {
    return { accepted: [], rejected: records.map(r => ({ id: String(r?.id ?? ''), reason: 'sync_disabled' })), server_updated_at: now }
  }
  if (records.length > MAX_PUSH_BATCH) {
    records = records.slice(0, MAX_PUSH_BATCH)
  }

  const accepted: string[] = []
  const rejected: Array<{ id: string; reason: string }> = []

  transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO history (
        id, user_id, status, mode, refined_text, duration, created_at, updated_at,
        server_updated_at, cloud_received_at, audio_local_path, audio_metadata, app_version, mic_device,
        mic_device_info, client_metadata, mode_meta, debug_info, audio_context
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id, user_id) DO UPDATE SET
        status = excluded.status,
        mode = excluded.mode,
        refined_text = excluded.refined_text,
        duration = excluded.duration,
        updated_at = excluded.updated_at,
        server_updated_at = excluded.server_updated_at,
        cloud_received_at = COALESCE(history.cloud_received_at, history.server_updated_at),
        audio_local_path = excluded.audio_local_path,
        audio_metadata = excluded.audio_metadata,
        app_version = excluded.app_version,
        mic_device = excluded.mic_device,
        mic_device_info = excluded.mic_device_info,
        client_metadata = excluded.client_metadata,
        mode_meta = excluded.mode_meta,
        debug_info = excluded.debug_info,
        audio_context = excluded.audio_context
    `)

    for (const r of records) {
      if (!r?.id || typeof r.id !== 'string') {
        rejected.push({ id: String(r?.id ?? 'unknown'), reason: 'missing_id' })
        continue
      }
      const invalid = invalidField(r)
      if (invalid) {
        rejected.push({ id: r.id, reason: `invalid_${invalid}` })
        continue
      }
      if (db.prepare('SELECT 1 FROM history_deletions WHERE user_id = ? AND id = ?').get(userId, r.id)) {
        rejected.push({ id: r.id, reason: 'record_deleted' })
        continue
      }
      if (db.prepare('SELECT 1 FROM history_cloud_evictions WHERE user_id = ? AND id = ?').get(userId, r.id)) {
        rejected.push({ id: r.id, reason: 'cloud_record_evicted' })
        continue
      }
      if (!isSyncCandidate(r)) {
        rejected.push({ id: r.id, reason: 'not_sync_candidate' })
        continue
      }

      try {
        upsert.run(
          r.id, userId, r.status ?? null, r.mode ?? 'voice_transcript',
          r.refined_text ?? null, r.duration ?? null,
          r.created_at ?? new Date(now).toISOString(),
          r.updated_at ?? new Date(now).toISOString(),
          ++updatedAt, now,
          r.audio_local_path ?? null, r.audio_metadata ?? null,
          r.app_version ?? '0.0.0', r.mic_device ?? null,
          toBlob(r.mic_device_info), toBlob(r.client_metadata),
          toBlob(r.mode_meta), r.debug_info ?? null, r.audio_context ?? null
        )
        accepted.push(r.id)
      } catch (err) {
        rejected.push({ id: r.id, reason: (err as Error).message.slice(0, 80) })
      }
    }
  })

  return { accepted, rejected, server_updated_at: updatedAt }
}

export interface PullResult {
  records: HistoryRecord[]
  deleted?: string[]
  evicted?: string[]
  cursor: number
  has_more: boolean
}

/** Old batches share a timestamp. Never split such a group with a numeric cursor. */
function timestampPage(userId: string, rows: Array<Record<string, unknown>>, limit: number, direction: 'ASC' | 'DESC', fallback: number): PullResult {
  let page = rows.slice(0, limit)
  let hasMore = rows.length > limit
  const cursor = page.length ? Number(page[page.length - 1].server_updated_at) : fallback
  if (hasMore && Number(rows[limit].server_updated_at) === cursor) {
    const tied = getDb().prepare('SELECT * FROM history WHERE user_id = ? AND server_updated_at = ? ORDER BY id')
      .all(userId, cursor) as Array<Record<string, unknown>>
    page = [...page.filter(row => Number(row.server_updated_at) !== cursor), ...tied]
    hasMore = Boolean(getDb().prepare(`SELECT 1 FROM history WHERE user_id = ? AND server_updated_at ${direction === 'ASC' ? '>' : '<'} ? LIMIT 1`)
      .get(userId, cursor))
  }
  return { records: page.map(normalizeRow), cursor, has_more: hasMore }
}

/**
 * 增量拉取：返回 server_updated_at > since 的记录。
 *
 * 用 server_updated_at 而非 created_at 作游标——客户端本地时钟不可信，
 * 且记录可能被服务端修改（如云端保留期清理后的更新）。
 */
export function pullHistory(userId: string, since: number, limit = PAGE_SIZE): PullResult {
  expireCloudHistory(userId)
  limit = Math.max(1, Math.min(500, Math.floor(limit) || PAGE_SIZE))
  const db = getDb()
  // One cursor orders both live content and deletions; a deletion-only page advances it too.
  const changes = `SELECT id, server_updated_at, 0 AS deleted FROM history WHERE user_id = ?
    UNION ALL SELECT id, server_updated_at, 1 AS deleted FROM history_deletions WHERE user_id = ?
    UNION ALL SELECT id, server_updated_at, 2 AS deleted FROM history_cloud_evictions WHERE user_id = ?`
  const rows = db.prepare(`SELECT * FROM (${changes}) WHERE server_updated_at > ?
    ORDER BY server_updated_at, id LIMIT ?`).all(userId, userId, userId, since, limit + 1) as Array<{ id: string; server_updated_at: number; deleted: number }>
  let page = rows.slice(0, limit)
  const cursor = page.at(-1)?.server_updated_at ?? since
  let hasMore = rows.length > limit
  if (hasMore && rows[limit].server_updated_at === cursor) {
    const tied = db.prepare(`SELECT * FROM (${changes}) WHERE server_updated_at = ? ORDER BY id`)
      .all(userId, userId, userId, cursor) as typeof rows
    page = [...page.filter(r => r.server_updated_at !== cursor), ...tied]
    hasMore = Boolean(db.prepare(`SELECT 1 FROM (${changes}) WHERE server_updated_at > ? LIMIT 1`).get(userId, userId, userId, cursor))
  }
  const read = db.prepare('SELECT * FROM history WHERE user_id = ? AND id = ?')
  return {
    records: page.filter(r => !r.deleted).map(r => normalizeRow(read.get(userId, r.id) as Record<string, unknown>)),
    deleted: page.filter(r => r.deleted === 1).map(r => r.id),
    evicted: page.filter(r => r.deleted === 2).map(r => r.id),
    cursor, has_more: hasMore,
  }
}

/**
 * 向历史方向翻页（backfill）。
 *
 * 与 pull 的区别：pull 是「拉新」，load_older 是「往回翻」。
 * 用 server_updated_at < before 倒序取，用于用户滚动到列表底部加载更早的记录。
 */
export function loadOlder(
  userId: string,
  before: number | null,
  limit = PAGE_SIZE,
  purgeBeforeAt?: number
): PullResult {
  expireCloudHistory(userId)
  const db = getDb()
  limit = Math.max(1, Math.min(500, Math.floor(limit) || PAGE_SIZE))

  // Age is first server receipt; the update cursor is independent of age.
  // Keep this old argument for API compatibility, never use it to skip rows.
  void purgeBeforeAt

  const rows = (before === null
    ? db.prepare(`
        SELECT id, status, mode, refined_text, duration, created_at, updated_at,
               server_updated_at, audio_local_path, audio_metadata, app_version,
               mic_device, mic_device_info, client_metadata, mode_meta, debug_info, audio_context
        FROM history WHERE user_id = ?
        ORDER BY server_updated_at DESC LIMIT ?
      `).all(userId, limit + 1)
    : db.prepare(`
        SELECT id, status, mode, refined_text, duration, created_at, updated_at,
               server_updated_at, audio_local_path, audio_metadata, app_version,
               mic_device, mic_device_info, client_metadata, mode_meta, debug_info, audio_context
        FROM history WHERE user_id = ? AND server_updated_at < ?
        ORDER BY server_updated_at DESC LIMIT ?
      `).all(userId, before, limit + 1)
  ) as Array<Record<string, unknown>>

  return timestampPage(userId, rows, limit, 'DESC', before ?? 0)
}

/** BLOB 列转成字符串，让 JSON 响应可读。 */
function normalizeRow(row: Record<string, unknown>): HistoryRecord {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v
  }
  return out as unknown as HistoryRecord
}

export interface SyncStatus {
  history_deletion_version: number
  cloud_lifecycle_version: number
  cloud_epoch: number
  total: number
  latest_server_updated_at: number
  earliest_server_updated_at: number | null
  cloud_retention: number
  sync_enabled: boolean
  purge_before_at: number | null
}

export function isSyncEnabled(userId: string): boolean {
  const settings = getDb().prepare('SELECT sync_enabled FROM sync_settings WHERE user_id = ?')
    .get(userId) as { sync_enabled: number } | undefined
  return settings ? settings.sync_enabled === 1 : false
}

export function getSyncStatus(userId: string): SyncStatus {
  expireCloudHistory(userId)
  const db = getDb()
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(MAX(server_updated_at), 0) AS latest,
           MIN(server_updated_at) AS earliest
    FROM history WHERE user_id = ?
  `).get(userId) as { total: number; latest: number; earliest: number | null }

  const settings = db.prepare(
    'SELECT cloud_retention, sync_enabled, purge_before_at FROM sync_settings WHERE user_id = ?'
  ).get(userId) as { cloud_retention: number; sync_enabled: number; purge_before_at: number | null } | undefined

  return {
    history_deletion_version: 1,
    cloud_lifecycle_version: 1,
    cloud_epoch: cloudEpoch(userId),
    total: stats.total,
    latest_server_updated_at: latestChange(userId),
    earliest_server_updated_at: stats.earliest,
    cloud_retention: settings?.cloud_retention ?? -1,
    sync_enabled: settings ? settings.sync_enabled === 1 : false,
    purge_before_at: settings?.purge_before_at ?? null
  }
}

/**
 * 更新同步设置。
 *
 * cloud_retention 单位是天，-1 表示永久保留。
 * 收紧保留期时立即执行云端清理；purge_before_at 是清理年龄边界，
 * 不能作为增量更新游标，也不要求客户端删除本机记录。
 */
export function updateSyncSettings(
  userId: string,
  patch: { cloud_retention?: number; sync_enabled?: boolean }
): SyncStatus {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || (patch.cloud_retention !== undefined && ![-1, 7, 30, 90].includes(patch.cloud_retention))
    || (patch.sync_enabled !== undefined && typeof patch.sync_enabled !== 'boolean')) throw new Error('invalid_sync_settings')
  const db = getDb()
  const now = Date.now()

  const current = db.prepare('SELECT cloud_retention, sync_enabled FROM sync_settings WHERE user_id = ?')
    .get(userId) as { cloud_retention: number; sync_enabled: number } | undefined

  const retention = patch.cloud_retention ?? current?.cloud_retention ?? -1
  const enabled = patch.sync_enabled !== undefined ? (patch.sync_enabled ? 1 : 0) : (current?.sync_enabled ?? 0)

  db.prepare(`
    INSERT INTO sync_settings (user_id, cloud_retention, sync_enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      cloud_retention = excluded.cloud_retention,
      sync_enabled = excluded.sync_enabled,
      updated_at = excluded.updated_at
  `).run(userId, retention, enabled, now)

  return getSyncStatus(userId)
}

export function cloudEpoch(userId: string): number {
  return (getDb().prepare('SELECT cloud_epoch FROM sync_settings WHERE user_id = ?').get(userId) as { cloud_epoch: number } | undefined)?.cloud_epoch ?? 0
}

/** Call inside a transaction. Mark cloud-only eviction without instructing
 * clients to erase their own history or audio; explicit deletion still wins. */
function evictCloudRows(userId: string, ids: string[], now: number): number {
  const db = getDb()
  let cursor = Math.max(now, latestChange(userId)), deleted = 0
  const insert = db.prepare('INSERT OR IGNORE INTO history_cloud_evictions (id, user_id, server_updated_at) VALUES (?, ?, ?)')
  const remove = db.prepare('DELETE FROM history WHERE user_id = ? AND id = ?')
  for (const id of ids) { insert.run(id, userId, ++cursor); deleted += Number(remove.run(userId, id).changes) }
  return deleted
}

/** Startup/periodic cleanup plus read/write boundary enforcement. A fixed first
 * receipt timestamp prevents later edits or re-uploads from extending retention. */
export function expireCloudHistory(userId?: string, now = Date.now()): number {
  const db = getDb()
  const settings = db.prepare(`SELECT user_id, cloud_retention FROM sync_settings WHERE cloud_retention > 0${userId ? ' AND user_id = ?' : ''}`)
    .all(...(userId ? [userId] : [])) as { user_id: string; cloud_retention: number }[]
  if (!settings.length) return 0
  return transaction(() => {
    let deleted = 0
    for (const setting of settings) {
      const before = now - setting.cloud_retention * 86400000
      const ids = db.prepare('SELECT id FROM history WHERE user_id = ? AND COALESCE(cloud_received_at, server_updated_at) < ?')
        .all(setting.user_id, before) as { id: string }[]
      deleted += evictCloudRows(setting.user_id, ids.map(r => r.id), now)
      db.prepare('UPDATE sync_settings SET purge_before_at = ? WHERE user_id = ?').run(before, setting.user_id)
    }
    return deleted
  })
}

/** Repeating the same request cannot erase newer recordings. The epoch fences
 * stale in-flight uploads, including IDs the server had never seen at wipe time. */
export function wipeHistory(userId: string, requestId: string): { deleted: number; cloud_epoch: number } {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('invalid_wipe_request')
  const db = getDb()
  return transaction(() => {
    const prior = db.prepare('SELECT deleted, cloud_epoch FROM history_cloud_wipes WHERE user_id = ? AND request_id = ?').get(userId, requestId)
    if (prior) return prior as { deleted: number; cloud_epoch: number }
    const now = Date.now(), epoch = cloudEpoch(userId) + 1
    const ids = db.prepare('SELECT id FROM history WHERE user_id = ?').all(userId) as { id: string }[]
    const deleted = evictCloudRows(userId, ids.map(r => r.id), now)
    db.prepare(`INSERT INTO sync_settings (user_id, cloud_epoch, updated_at, sync_enabled) VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET cloud_epoch = excluded.cloud_epoch, updated_at = excluded.updated_at`).run(userId, epoch, now)
    db.prepare('INSERT INTO history_cloud_wipes (request_id, user_id, cloud_epoch, deleted) VALUES (?, ?, ?, ?)').run(requestId, userId, epoch, deleted)
    return { deleted, cloud_epoch: epoch }
  })
}

/**
 * 确认同步告警。
 *
 * 用于处理「本地记录数远超云端」等异常提示，
 * 用户确认后不再重复提示。
 */
export function acknowledgeHints(userId: string, hints: unknown): { acknowledged: string[] } {
  const list = Array.isArray(hints) ? hints.map(String) : []
  // 当前实现只需记录已确认，不做持久化——提示是幂等的，
  // 且客户端已保存确认状态，服务端重复下发不会造成问题
  return { acknowledged: list }
}

/** 服务端下发的域名黑名单。 */
export function getDomainBlacklist(): string[] {
  const db = getDb()
  const rows = db.prepare('SELECT domain FROM domain_blacklist ORDER BY domain').all() as Array<{ domain: string }>
  return rows.map((r) => r.domain)
}

export function addDomainBlacklist(domains: string[]): void {
  const db = getDb()
  const now = Date.now()
  const stmt = db.prepare('INSERT OR IGNORE INTO domain_blacklist (domain, created_at) VALUES (?, ?)')
  transaction(() => {
    for (const d of domains) stmt.run(d, now)
  })
}
