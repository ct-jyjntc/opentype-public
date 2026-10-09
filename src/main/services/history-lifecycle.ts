import { mkdir, unlink, writeFile, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { HistoryRepo, type HistorySyncAccount } from '../db'
import { jsonObject } from './voice-context'

/** Prefer the exact owned file saved in history, including a recovered format.
 * Never follow an arbitrary legacy/cloud audio path or a symlink. */
export async function readStoredAudio(directory: string, id: string): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id) || await HistoryRepo.isDeleted(id)) return null
  const row = await HistoryRepo.byId(id)
  const extensions = ['ogg','wav','webm']
  const preferred = extensions.find(ext => row?.audioLocalPath === join(directory,`${id}.${ext}`))
  const ordered = preferred ? jsonObject(row?.modeMeta).recovered_audio
    ? [preferred] : [preferred,...extensions.filter(ext=>ext!==preferred)] : extensions
  for (const extension of ordered) {
    let handle
    try {
      handle = await open(join(directory,`${id}.${extension}`),constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!(await handle.stat()).isFile()) continue
      const bytes = await handle.readFile()
      return await HistoryRepo.isDeleted(id) ? null : bytes
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    finally { await handle?.close() }
  }
  return null
}

/** Delete only app-owned audio names. Failed filesystem work remains in SQLite across restarts. */
export class HistoryLifecycle {
  private cleanup = Promise.resolve(new Set<string>())
  private writes = new Map<string, Promise<string>>()

  isWriting(id: string): boolean { return this.writes.has(id) }

  constructor(private readonly audioDirectory: string,
    private readonly cancel: (id: string) => void,
    private readonly changed: () => void,
    private readonly removeFile: (path: string) => Promise<void> = unlink,
    private readonly persistFile: (path: string, bytes: Uint8Array) => Promise<void> =
      (path, bytes) => writeFile(path, bytes, { flag: constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW })) {}

  /** Register writes before the first await: deletion must wait for every open writer. */
  async saveAudio(id: string, extension: string, bytes: Uint8Array, replace = false): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('invalid_audio_id')
    if (!['wav', 'ogg', 'webm'].includes(extension)) throw new Error('invalid_audio_format')
    const previous = this.writes.get(id)
    const pending = (async () => {
      await previous?.catch(() => {})
      if (await HistoryRepo.isDeleted(id)) throw new Error('record_deleted')
      await mkdir(this.audioDirectory, { recursive: true })
      const path = join(this.audioDirectory, `${id}.${extension}`)
      await this.persistFile(path, bytes)
      if (replace) {
        for (const old of ['wav', 'ogg', 'webm']) {
          if (old === extension) continue
          try { await this.removeFile(join(this.audioDirectory, `${id}.${old}`)) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
      }
      if (await HistoryRepo.isDeleted(id)) throw new Error('record_deleted')
      return path
    })()
    this.writes.set(id, pending)
    try { return await pending }
    finally { if (this.writes.get(id) === pending) this.writes.delete(id) }
  }

  async remove(id: string, account?: HistorySyncAccount) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('invalid_audio_id')
    this.cancel(id)
    await HistoryRepo.remove(id, account)
    this.changed()
    if ((await this.flushAudioCleanup()).has(id)) throw new Error('audio_cleanup_pending')
  }

  async applyRemoteDeletions(ids: string[], account: HistorySyncAccount) {
    const valid = ids.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id))
    if (valid.length !== ids.length) throw new Error('invalid_deletion_ids')
    const removed = await HistoryRepo.applyRemoteDeletions(valid, account)
    for (const id of removed) this.cancel(id)
    if (removed.length) this.changed()
    // Text deletion is already durable. Failed audio cleanup is retried independently.
    await this.flushAudioCleanup()
  }

  async clear() {
    // Snapshot deletion and tombstones are atomic. New captures after this snapshot survive.
    const ids = await HistoryRepo.clear()
    for (const id of ids) this.cancel(id)
    this.changed()
    if ((await this.flushAudioCleanup()).size) throw new Error('audio_cleanup_pending')
  }

  async purgeOlderThan(days: number) {
    const ids = await HistoryRepo.expireOlderThan(days)
    for (const id of ids) this.cancel(id)
    if (ids.length) this.changed()
    if ((await this.flushAudioCleanup()).size) throw new Error('audio_cleanup_pending')
    return ids.length
  }

  flushAudioCleanup(): Promise<Set<string>> {
    // Each request gets a complete pass, including deletions queued as a previous
    // pass finishes. Recover the queue after a database error without swallowing it
    // for the caller that encountered it.
    const next = this.cleanup.catch(() => new Set<string>()).then(() => this.drain())
    this.cleanup = next
    return next
  }

  private async drain() {
    const failed = new Set<string>()
    let cursor = ''
    for (;;) {
      const ids = await HistoryRepo.pendingAudioCleanup(cursor)
      if (!ids.length) break
      for (const id of ids) {
        // A cancelled capture may still have a writeFile call in flight.
        // Unlinking before it opens the file could leave a new orphan afterward.
        await this.writes.get(id)?.catch(() => {})
        let success = true
        // Never use audioLocalPath from a synced/legacy row as a deletion target.
        if (/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
          for (const extension of ['wav', 'ogg', 'webm']) {
            try { await this.removeFile(join(this.audioDirectory, `${id}.${extension}`)) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') success = false }
          }
        }
        if (success) { await HistoryRepo.markAudioRemoved(id); failed.delete(id) }
        else failed.add(id)
      }
      cursor = ids[ids.length - 1]
    }
    return failed
  }
}
