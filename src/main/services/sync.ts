// 云端历史同步引擎。
//
// 同步语义：
// - 增量推送（防抖 10s，批量 200 条）
// - 游标拉取（按 server_updated_at 增量）
// - 会话代际隔离（账号切换时在途任务自动失效）
// - 失败重试上限 3 次
//
// 为什么需要代际机制：账号切换时可能有请求在途，
// 若不做隔离，A 账号的响应会被写到 B 账号的数据里。
// 递增代际比手动取消 Promise 更可靠——后者容易漏掉某个分支。

import { serviceRequest as request } from './network'
import { assertSecureSyncUrl, syncScope } from './sync-scope'

/** 单批推送上限。 */
const MAX_PUSH_BATCH = 200
/** 推送防抖延迟。 */
const PUSH_DEBOUNCE_MS = 10_000
/** 失败重试上限。 */
const MAX_SYNC_ATTEMPTS = 3

export interface SyncRecord {
  id: string
  status?: string
  mode?: string
  refined_text?: string
  duration?: number
  created_at?: string
  updated_at?: string
  audio_metadata?: string
  app_version?: string
  mic_device?: string
  mode_meta?: string
  audio_context?: string
}

export interface SyncStatus {
  history_deletion_version?: number
  cloud_lifecycle_version?: number
  cloud_epoch?: number
  total: number
  latest_server_updated_at: number
  earliest_server_updated_at: number | null
  cloud_retention: number
  sync_enabled: boolean
  purge_before_at: number | null
}

export interface PullResult {
  records: SyncRecord[]
  deleted?: string[]
  evicted?: string[]
  cursor: number
  has_more: boolean
}

export interface SyncEngineOptions {
  baseUrl: string
  appVersion: string
  getToken: () => Promise<string | null>
  getUserId: () => string | null
  /** 从本地库取待推送记录 */
  loadPendingRecords: (userId: string, limit: number, includeExhausted?: boolean) => Promise<SyncRecord[]>
  /** Persist account-specific opt-outs, including a failed/offline disable request. */
  loadSyncBlocked?: (userId: string) => boolean
  saveSyncBlocked?: (userId: string, blocked: boolean) => void
  requestTimeoutMs?: number
  pushDebounceMs?: number
  retryDelayMs?: number
  /** 标记记录已同步 */
  markSynced: (ids: string[]) => Promise<void>
  /** 标记同步失败（累加尝试次数） */
  markFailed: (ids: string[]) => Promise<void>
  /** Release per-push bookkeeping for these ids (every outcome), or for everything when omitted. */
  releasePushed?: (ids?: string[]) => void
  /** 把拉取到的记录写入本地 */
  applyRemote: (records: SyncRecord[], userId: string) => Promise<void>
  loadPendingDeletions?: (userId: string, limit: number, retryFailed: boolean) => string[]
  countPendingDeletions?: (userId: string) => number
  markDeletions?: (userId: string, ids: string[], acknowledged: boolean) => void
  applyRemoteDeletions?: (ids: string[], userId: string) => Promise<void>
  loadCursor?: (userId: string) => number
  saveCursor?: (userId: string, cursor: number) => void
  applyCloudEpoch?: (userId: string, epoch: number) => void
  applyCloudEvictions?: (ids: string[], userId: string) => void
  beginCloudWipe?: (userId: string) => string
  finishCloudWipe?: (userId: string, id: string) => void
  hasPendingCloudWipe?: (userId: string) => boolean
  cloudExcludedCount?: (userId: string) => number
  /** 状态变更通知 */
  onStateChange?: (state: { phase: string; detail?: string; total?: number; completed?: number }) => void
}

type Session = { generation: number; userId: string | null }
type PushResult = { pushed: number; accepted: number; detail?: string }

export class SyncEngine {
  private generation = 0
  private pushTimer: NodeJS.Timeout | null = null
  private pushing = false
  private pulling = false
  private wiping = false
  private disposed = false
  private failures = 0
  private controllers = new Set<AbortController>()
  private disabledUsers = new Set<string>()

  constructor(private readonly options: SyncEngineOptions) {}

  private session(): Session {
    return { generation: this.generation, userId: this.options.getUserId() }
  }

  private isCurrent(session: Session): boolean {
    return this.isCurrentGeneration(session.generation) && session.userId === this.options.getUserId()
  }

  private blocked(userId = this.options.getUserId()): boolean {
    return !userId || this.disabledUsers.has(userId) || Boolean(this.options.loadSyncBlocked?.(userId))
  }

  private setBlocked(userId: string, blocked: boolean): void {
    if (blocked) this.disabledUsers.add(userId)
    else this.disabledUsers.delete(userId)
    this.options.saveSyncBlocked?.(userId, blocked)
  }

  invalidateSession(): void {
    this.generation += 1
    this.failures = 0
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  get currentGeneration(): number { return this.generation }

  isCurrentGeneration(gen: number): boolean {
    return gen === this.generation && !this.disposed
  }

  dispose(): void {
    this.disposed = true
    this.invalidateSession()
  }

  private notify(phase: string, detail?: string, total = 0, completed = 0): void {
    this.options.onStateChange?.({ phase, detail, total, completed })
  }

  private consumeCloudState(status: SyncStatus, userId: string): void {
    if (status.cloud_lifecycle_version !== 1) return
    const epoch = status.cloud_epoch
    if (!Number.isSafeInteger(epoch) || epoch! < 0) throw new Error('invalid_cloud_epoch')
    if (!this.options.applyCloudEpoch && epoch! > 0) throw new Error('cloud_lifecycle_store_missing')
    this.options.applyCloudEpoch?.(userId, epoch!)
  }

  // Every request is scoped to the account that started it, including token refresh
  // and response-body reads. Disabling sync aborts all in-flight requests immediately.
  private async post(path: string, body: unknown, session = this.session(), sensitive = false): Promise<any> {
    if (!session.userId || !this.isCurrent(session)) throw new Error('session_changed')
    assertSecureSyncUrl(this.options.baseUrl)
    const token = await this.options.getToken()
    if (!this.isCurrent(session)) throw new Error('session_changed')
    if (!token) throw new Error('not_authenticated')
    if (sensitive && this.blocked(session.userId)) throw new Error('sync_disabled')
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const res = await request(`${syncScope(this.options.baseUrl)}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `OpenType/${this.options.appVersion}`,
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000)])
      })
      const payload = await res.body.json() as Record<string, any>
      if (!this.isCurrent(session)) throw new Error('session_changed')
      if (sensitive && this.blocked(session.userId)) throw new Error('sync_disabled')
      if (res.statusCode >= 400 || payload?.status !== 'OK') {
        throw new Error(payload?.detail ?? `http_${res.statusCode}`)
      }
      return payload.data
    } finally {
      this.controllers.delete(controller)
    }
  }

  schedulePush(): void {
    if (this.disposed || this.blocked()) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.synchronize()
    }, this.options.pushDebounceMs ?? PUSH_DEBOUNCE_MS)
    this.pushTimer.unref?.()
  }

  private scheduleRetry(session: Session): void {
    this.failures += 1
    if (!this.isCurrent(session) || this.blocked(session.userId) || this.failures >= MAX_SYNC_ATTEMPTS) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.synchronize()
    }, (this.options.retryDelayMs ?? 5_000) * 2 ** (this.failures - 1))
    this.pushTimer.unref?.()
  }

  /** Manual retries can include exhausted records; background work respects the attempt limit. */
  async pushNow({ retryFailed = false }: { retryFailed?: boolean } = {}): Promise<PushResult> {
    const session = this.session()
    const result: PushResult = { pushed: 0, accepted: 0 }
    if (!session.userId || this.disposed || this.pushing || this.wiping) return result
    if (this.blocked(session.userId)) { this.notify('idle', 'sync_disabled'); return { ...result, detail: 'sync_disabled' } }
    this.pushing = true
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    let unacknowledged: string[] = []
    let unacknowledgedDeletions: string[] = []
    try {
      // No record is read or sent until the server confirms that sync is enabled.
      const status = await this.post('/transcription_history/sync_status', {}, session)
      this.consumeCloudState(status, session.userId)
      if (status?.sync_enabled !== true || this.blocked(session.userId)) {
        this.notify('idle', 'sync_disabled')
        return { ...result, detail: 'sync_disabled' }
      }
      if (retryFailed) this.failures = 0
      const processed = new Set<string>()
      const processedDeletions = new Set<string>()
      while (this.isCurrent(session) && !this.blocked(session.userId)) {
        const deletions = this.options.loadPendingDeletions?.(session.userId, MAX_PUSH_BATCH, retryFailed) ?? []
        if (deletions.length) {
          if (status.history_deletion_version !== 1) throw new Error('cloud_deletion_unsupported')
          if (!this.options.markDeletions) throw new Error('cloud_deletion_store_missing')
          if (deletions.some(id => processedDeletions.has(id))) throw new Error('sync_deletion_queue_did_not_advance')
          deletions.forEach(id => processedDeletions.add(id))
          unacknowledgedDeletions = deletions
          this.notify('pushing', 'deleting_cloud_records')
          const data = await this.post('/transcription_history/delete', { ids: deletions }, session, true)
          const accepted = new Set<string>((Array.isArray(data?.accepted) ? data.accepted : [])
            .filter((id: unknown) => typeof id === 'string' && deletions.includes(id)))
          this.options.markDeletions(session.userId, [...accepted], true)
          unacknowledgedDeletions = deletions.filter(id => !accepted.has(id))
          if (unacknowledgedDeletions.length) throw new Error('cloud_deletion_rejected')
          continue
        }
        const pending = await this.options.loadPendingRecords(session.userId, MAX_PUSH_BATCH, retryFailed)
        if (!this.isCurrent(session)) return result
        if (pending.length === 0) break
        // A record edited while its push was in flight legitimately returns with new content;
        // only an identical snapshot coming back means the queue is stuck.
        if (pending.some(r => processed.has(JSON.stringify(r)))) throw new Error('sync_queue_did_not_advance')
        for (const record of pending) processed.add(JSON.stringify(record))
        unacknowledged = pending.map(r => r.id)
        result.pushed += pending.length
        this.notify('pushing', undefined, result.pushed, result.accepted)
        const data = await this.post('/transcription_history/push', { records: pending,
          ...(status.cloud_lifecycle_version === 1 ? { cloud_epoch: status.cloud_epoch } : {}) }, session, true)
        const ids = new Set(unacknowledged)
        const accepted = (Array.isArray(data?.accepted) ? data.accepted : []).filter((id: unknown): id is string => typeof id === 'string' && ids.has(id))
        const rejected = (Array.isArray(data?.rejected) ? data.rejected : []) as Array<{id: string; reason: string}>
        const skipped = rejected.filter(r => ids.has(r.id) && r.reason === 'not_sync_candidate').map(r => r.id)
        const deleted = rejected.filter(r => ids.has(r.id) && r.reason === 'record_deleted').map(r => r.id)
        const evicted = rejected.filter(r => ids.has(r.id) && r.reason === 'cloud_record_evicted').map(r => r.id)
        if (evicted.length) {
          if (!this.options.applyCloudEvictions) throw new Error('cloud_lifecycle_store_missing')
          this.options.applyCloudEvictions(evicted, session.userId)
        }
        if (deleted.length) {
          if (!this.options.applyRemoteDeletions) throw new Error('cloud_deletion_handler_missing')
          await this.options.applyRemoteDeletions(deleted, session.userId)
          if (!this.isCurrent(session)) return result
        }
        if (accepted.length || skipped.length) await this.options.markSynced([...accepted, ...skipped])
        // Rejected ids (record_deleted, cloud_record_evicted, invalid_*) are never marked synced; release them too.
        this.options.releasePushed?.([...ids])
        if (!this.isCurrent(session)) return result
        result.accepted += accepted.length
        const acknowledged = new Set([...accepted, ...skipped, ...deleted, ...evicted])
        unacknowledged = unacknowledged.filter(id => !acknowledged.has(id))
        if (unacknowledged.length) throw new Error('sync_records_rejected')
      }
      if (this.isCurrent(session)) {
        this.failures = 0
        // The renderer closes its dialog after a complete syncing -> idle cycle,
        // including an empty queue.
        this.notify('pushing', undefined, result.pushed, result.accepted)
        this.notify('idle')
      }
      return result
    } catch (err) {
      if (this.isCurrent(session) && !this.blocked(session.userId)) {
        const detail = (err as Error).message
        result.detail = detail
        if (detail !== 'sync_disabled') {
          if (unacknowledged.length) await this.options.markFailed(unacknowledged)
          if (unacknowledgedDeletions.length) this.options.markDeletions?.(session.userId, unacknowledgedDeletions, false)
          if (this.isCurrent(session)) { this.notify('error', detail); this.scheduleRetry(session) }
        } else this.notify('idle', detail)
      }
      return result
    } finally {
      // Pushes are exclusive: nothing from this run (including a batch abandoned on session change) is still in flight.
      this.options.releasePushed?.()
      this.pushing = false
    }
  }

  async synchronize(options: { retryFailed?: boolean } = {}): Promise<PushResult> {
    const session = this.session()
    const result = await this.pushNow(options)
    if (this.isCurrent(session)) await this.pull()
    return result
  }

  async pull(since?: number): Promise<{ applied: number; cursor: number; detail?: string }> {
    const session = this.session()
    let cursor = since ?? (session.userId ? this.options.loadCursor?.(session.userId) : 0) ?? 0
    let applied = 0
    let detail: string | undefined
    if (!session.userId || this.blocked(session.userId) || this.pulling || this.wiping) return { applied, cursor }
    this.pulling = true
    try {
      const status = await this.post('/transcription_history/sync_status', {}, session)
      this.consumeCloudState(status, session.userId)
      if (status?.sync_enabled !== true) return { applied, cursor }
      while (this.isCurrent(session) && !this.blocked(session.userId)) {
        const data = await this.post('/transcription_history/pull', { since: cursor }, session, true) as PullResult
        const next = data.cursor
        if (!Number.isSafeInteger(next) || next < cursor || (data.has_more && next === cursor)) throw new Error('sync_cursor_did_not_advance')
        if (data.deleted?.length) {
          if (!this.options.applyRemoteDeletions) throw new Error('cloud_deletion_handler_missing')
          await this.options.applyRemoteDeletions(data.deleted, session.userId)
          if (!this.isCurrent(session)) break
        }
        if (data.evicted?.length) {
          if (!this.options.applyCloudEvictions) throw new Error('cloud_lifecycle_store_missing')
          this.options.applyCloudEvictions(data.evicted, session.userId)
        }
        if (data.records?.length) {
          await this.options.applyRemote(data.records, session.userId)
          if (!this.isCurrent(session)) break
          applied += data.records.length
        }
        this.options.saveCursor?.(session.userId, next)
        cursor = next
        if (!data.has_more) break
      }
    } catch (err) {
      detail = (err as Error).message
      if (this.isCurrent(session) && !this.blocked(session.userId)) this.notify('error', detail)
    } finally {
      this.pulling = false
    }
    return { applied, cursor, ...(detail ? { detail } : {}) }
  }

  async loadOlder(before: number | null, limit = 50): Promise<PullResult | null> {
    if (this.blocked()) return null
    try { return await this.post('/transcription_history/load_older', { before, limit }, this.session(), true) }
    catch { return null }
  }

  async getStatus(): Promise<SyncStatus | null> {
    const session = this.session()
    try {
      const status = await this.post('/transcription_history/sync_status', {}, session) as SyncStatus
      if (session.userId) this.consumeCloudState(status, session.userId)
      return { ...status, sync_enabled: status.sync_enabled === true && !this.blocked(session.userId) }
    } catch (err) {
      if (this.isCurrent(session) && session.userId) this.notify('error', (err as Error).message)
      return null
    }
  }

  localStatus(): { pendingDeletions: number; cloudExcluded: number; pendingCloudWipe: boolean } {
    const userId = this.options.getUserId()
    return { pendingDeletions: userId ? this.options.countPendingDeletions?.(userId) ?? 0 : 0,
      cloudExcluded: userId ? this.options.cloudExcludedCount?.(userId) ?? 0 : 0,
      pendingCloudWipe: userId ? this.options.hasPendingCloudWipe?.(userId) ?? false : false }
  }

  async updateSettings(patch: { cloud_retention?: number; sync_enabled?: boolean }): Promise<SyncStatus | null> {
    const userId = this.options.getUserId()
    if (!userId || this.disposed) return null
    if (patch.sync_enabled !== undefined) {
      // Retain this local opt-out even when the server is unreachable or the app restarts.
      if (patch.sync_enabled === false) this.setBlocked(userId, true)
      this.invalidateSession()
      this.notify('idle')
    }
    const session = this.session()
    try {
      if (patch.cloud_retention !== undefined) {
        if (![-1,7,30,90].includes(patch.cloud_retention)) throw new Error('invalid_sync_settings')
        const before = await this.post('/transcription_history/sync_status', {}, session)
        if (before.cloud_lifecycle_version !== 1) throw new Error('cloud_lifecycle_unsupported')
      }
      const status = await this.post('/transcription_history/sync_settings', patch, session) as SyncStatus
      this.consumeCloudState(status, userId)
      if (patch.sync_enabled === true && status.sync_enabled === true) {
        this.setBlocked(userId, false)
        this.schedulePush()
      }
      return { ...status, sync_enabled: status.sync_enabled === true && !this.blocked(userId) }
    } catch (error) { if (this.isCurrent(session)) this.notify('error', (error as Error).message); return null }
  }

  async wipeCloud(): Promise<boolean> {
    if (this.wiping || this.disposed || !this.options.getUserId()) return false
    this.wiping = true
    this.invalidateSession()
    const session = this.session()
    this.notify('clearing_cloud')
    try {
      const status = await this.post('/transcription_history/sync_status', {}, session)
      if (status.cloud_lifecycle_version !== 1) throw new Error('cloud_lifecycle_unsupported')
      if (!this.options.beginCloudWipe || !this.options.finishCloudWipe || !this.options.applyCloudEpoch) throw new Error('cloud_lifecycle_store_missing')
      this.consumeCloudState(status, session.userId!)
      const id = this.options.beginCloudWipe(session.userId!)
      const result = await this.post('/transcription_history/wipe', { request_id: id }, session)
      this.consumeCloudState({ cloud_lifecycle_version: 1, cloud_epoch: result?.cloud_epoch } as SyncStatus, session.userId!)
      this.options.finishCloudWipe(session.userId!, id)
      this.notify('idle')
      return true
    } catch (error) {
      if (this.isCurrent(session)) this.notify('error', (error as Error).message)
      return false
    } finally { this.wiping = false }
  }

  /** 记录已同步，避免重复推送。 */
  static isSyncCandidate(record: SyncRecord): boolean {
    if (record.status !== 'completed') return false
    if (record.refined_text && record.refined_text.trim() !== '') return true
    if (record.mode === 'voice_command' && record.mode_meta) {
      try {
        const meta = typeof record.mode_meta === 'string' ? JSON.parse(record.mode_meta) : record.mode_meta
        return (meta as any)?.ai_result?.delivery === 'external'
      } catch {
        return false
      }
    }
    return false
  }
}

export { MAX_PUSH_BATCH, PUSH_DEBOUNCE_MS, MAX_SYNC_ATTEMPTS }
