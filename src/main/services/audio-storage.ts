import { randomUUID } from 'node:crypto'
import { constants, lstatSync, mkdirSync, renameSync, linkSync, unlinkSync, type Stats } from 'node:fs'
import { opendir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AudioStorageRepo } from '../db'
import type { AudioStorageAction, AudioStorageResult, AudioStorageSnapshot, StoredAudio } from '../../shared/audio-storage'

const DAY = 86400000, REVIEW_TTL = 10 * 60_000, PAGE = 200, PREVIEW_LIMIT = 32 * 1024 * 1024
const NAME = /^([a-zA-Z0-9_-]{1,200})\.(wav|ogg|webm)$/
const KEY = /^[a-f0-9-]{36}$/
interface Stamp { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Entry { name: string; stamp: Stamp; phase: 'moving' | 'recycled' | 'restoring' | 'erasing' }
interface Reviewed extends StoredAudio { stamp: Stamp; recycled: boolean }
interface StorageOptions {
  isBusy: () => boolean
  isWriting: (id: string) => boolean
  changed: () => void
  now?: () => number
  rename?: typeof renameSync
  link?: typeof linkSync
  unlink?: typeof unlinkSync
}
const stamp = (s: Stats): Stamp => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs })
function same(a: Stamp, b: Stamp, moved = false) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && (moved || a.ctimeMs === b.ctimeMs)
}
function stat(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function regular(s: Stats | null): s is Stats { return !!s && s.isFile() && !s.isSymbolicLink() }
function parseEntry(key: string, payload: string): Entry | null {
  try {
    const v = JSON.parse(payload) as Entry
    if (!KEY.test(key) || !NAME.test(v.name) || !['moving','recycled','restoring','erasing'].includes(v.phase)
      || !['dev','ino','size','mtimeMs','ctimeMs'].every(k => Number.isFinite(v.stamp[k as keyof Stamp]))) return null
    return v
  } catch { return null }
}

/** Review-only discovery; mutations use a short-lived main-process snapshot and
 * revalidate identifiers, ownership, file identity and active writers synchronously.
 * A SQLite journal makes the file move/restore/delete phases recoverable after exit. */
export class AudioStorage {
  private review: { token: string; expires: number; files: Map<string, Reviewed> } | null = null
  private recycleDirectory: string
  constructor(private readonly directory: string, private readonly options: StorageOptions) {
    this.recycleDirectory = join(directory, '.recycle')
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private roots() {
    for (const path of [this.directory, this.recycleDirectory]) {
      const s = stat(path)
      if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('audio_storage_unsafe_directory')
    }
  }
  private save(key: string, entry: Entry) { AudioStorageRepo.save(key, JSON.stringify(entry)) }
  private protected(name: string, refs = AudioStorageRepo.references(), actualPath?: string) {
    const id = NAME.exec(name)?.[1]
    return !id || this.options.isWriting(id) || refs.ids.has(id.toLowerCase()) || refs.paths.has(resolve(this.directory, name).toLowerCase())
      || !!(actualPath && refs.paths.has(resolve(actualPath).toLowerCase()))
  }
  private checked(path: string, expected: Stamp, moved = false): Stats {
    const s = stat(path)
    if (!regular(s) || !same(expected, stamp(s), moved)) throw new Error('audio_storage_file_changed')
    return s
  }
  private finish(key: string, entry: Entry) {
    this.roots()
    if (this.options.isWriting(NAME.exec(entry.name)![1])) throw new Error('audio_storage_busy')
    const source = join(this.directory, entry.name), target = join(this.recycleDirectory, key)
    if (entry.phase === 'moving') {
      const dst = stat(target), src = stat(source)
      if (!dst) {
        if (this.protected(entry.name)) { AudioStorageRepo.remove(key); return }
        this.checked(source, entry.stamp)
        mkdirSync(this.recycleDirectory, { recursive: true })
        this.roots()
        ;(this.options.rename ?? renameSync)(source, target)
      } else if (src) throw new Error('audio_storage_conflict')
      const moved = this.checked(target, entry.stamp, true)
      this.save(key, { ...entry, phase: 'recycled', stamp: stamp(moved) })
    } else if (entry.phase === 'restoring') {
      const dst = stat(target), src = stat(source)
      if (!dst) {
        this.checked(source, entry.stamp, true)
        AudioStorageRepo.remove(key)
        return
      }
      this.checked(target, entry.stamp, true)
      if (src) {
        if (!regular(src) || !same(stamp(src), stamp(dst), true)) throw new Error('audio_storage_conflict')
      } else {
        // Hard-link creation is atomic and refuses to overwrite an existing path.
        ;(this.options.link ?? linkSync)(target, source)
      }
      this.checked(source, entry.stamp, true)
      ;(this.options.unlink ?? unlinkSync)(target)
      AudioStorageRepo.remove(key)
    } else if (entry.phase === 'erasing') {
      if (this.protected(entry.name,undefined,target)) throw new Error('audio_storage_referenced')
      if (stat(target)) { this.checked(target, entry.stamp); (this.options.unlink ?? unlinkSync)(target) }
      AudioStorageRepo.remove(key)
    }
  }
  private reconcile() {
    let unresolved = 0
    for (const row of AudioStorageRepo.entries()) {
      const entry = parseEntry(row.key, row.payload)
      if (!entry) { unresolved++; continue }
      if (entry.phase === 'recycled') continue
      if (entry.phase === 'erasing') {
        // Never repeat a permanent deletion just because the user scans storage.
        // A crash after unlink only needs journal acknowledgement; a file still
        // present goes back to the reviewable recycle bin for explicit retry.
        try {
          this.roots()
          const path = join(this.recycleDirectory, row.key)
          if (!stat(path)) AudioStorageRepo.remove(row.key)
          else { this.checked(path,entry.stamp); this.save(row.key,{...entry,phase:'recycled'}) }
        } catch { unresolved++ }
        continue
      }
      try { this.finish(row.key, entry) } catch { unresolved++ }
    }
    return unresolved
  }
  async scan(): Promise<AudioStorageSnapshot> {
    this.roots()
    const result: AudioStorageSnapshot = { token: randomUUID(), candidates: [], recycled: [], protectedFiles: 0, recentFiles: 0, unknownFiles: 0,
      unresolvedItems: this.options.isBusy() ? 0 : this.reconcile(), truncated: false }
    const files = new Map<string, Reviewed>(), refs = AudioStorageRepo.references()
    const journal = AudioStorageRepo.entries()
    const pending = new Set(journal.map(r => parseEntry(r.key, r.payload)?.name).filter(Boolean))
    if (stat(this.directory)) {
      const dir = await opendir(this.directory)
      for await (const file of dir) {
        if (file.name === '.recycle') continue
        if (!NAME.test(file.name) || !file.isFile() || file.isSymbolicLink()) { result.unknownFiles++; continue }
        const s = stat(join(this.directory, file.name))
        if (!regular(s) || s.nlink !== 1) { result.unknownFiles++; continue }
        if (this.protected(file.name, refs) || pending.has(file.name)) { result.protectedFiles++; continue }
        if (Math.max(s.mtimeMs, s.ctimeMs) > this.now() - DAY) { result.recentFiles++; continue }
        if (result.candidates.length >= PAGE) { result.truncated = true; continue }
        const item: Reviewed = { key: randomUUID(), name: file.name, bytes: s.size, modifiedAt: s.mtimeMs, stamp: stamp(s), recycled: false }
        files.set(item.key, item); result.candidates.push(item)
      }
    }
    for (const row of journal) {
      const entry = parseEntry(row.key, row.payload)
      if (!entry || entry.phase === 'moving') continue
      try {
        const s = this.checked(join(this.recycleDirectory, row.key), entry.stamp, entry.phase === 'restoring')
        if (result.recycled.length >= PAGE) { result.truncated = true; continue }
        const item: Reviewed = { key: row.key, name: entry.name, bytes: s.size, modifiedAt: s.mtimeMs, stamp: stamp(s), recycled: true }
        files.set(item.key, item); result.recycled.push(item)
      } catch { result.unresolvedItems++ }
    }
    this.review = { token: result.token, expires: this.now() + REVIEW_TTL, files }
    const publicItem = ({key,name,bytes,modifiedAt}: StoredAudio): StoredAudio => ({key,name,bytes,modifiedAt})
    result.candidates = result.candidates.map(publicItem); result.recycled = result.recycled.map(publicItem)
    return result
  }
  private reviewed(token: string, key: string) {
    if (!this.review || token !== this.review.token || this.now() > this.review.expires) throw new Error('audio_storage_review_expired')
    const file = this.review.files.get(key)
    if (!file) throw new Error('audio_storage_invalid_selection')
    this.roots()
    const path = file.recycled ? join(this.recycleDirectory, key) : join(this.directory, file.name)
    this.checked(path, file.stamp)
    return { file, path }
  }
  async preview(token: string, key: string): Promise<Uint8Array> {
    const { file, path } = this.reviewed(token,key)
    if (file.bytes > PREVIEW_LIMIT) throw new Error('audio_storage_preview_large')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!regular(before) || !same(file.stamp, stamp(before))) throw new Error('audio_storage_file_changed')
      // Bound allocation even if another process starts growing the file mid-read.
      const bytes = Buffer.alloc(file.bytes)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes,offset,bytes.length-offset,offset)
        if (!bytesRead) throw new Error('audio_storage_file_changed')
        offset += bytesRead
      }
      if (!same(file.stamp, stamp(await handle.stat()))) throw new Error('audio_storage_file_changed')
      return bytes
    } finally { await handle.close() }
  }
  act(token: string, keys: string[], action: AudioStorageAction): AudioStorageResult {
    if (this.options.isBusy()) throw new Error('audio_storage_busy')
    if (!['recycle','restore','recover','erase'].includes(action) || !Array.isArray(keys) || !keys.length || keys.length > PAGE
      || new Set(keys).size !== keys.length) throw new Error('audio_storage_invalid_selection')
    // Validate the entire request before touching any file. Failed individual work is reported below.
    const selected = keys.map(key => this.reviewed(token,key).file)
    if (selected.some(f => action === 'recycle' ? f.recycled : action === 'recover' ? false : !f.recycled)) throw new Error('audio_storage_invalid_selection')
    const result: AudioStorageResult = { completed: 0, bytes: 0, failed: [] }
    for (const f of selected) {
      try {
        const { path } = this.reviewed(token,f.key)
        if (this.protected(f.name,undefined,path) && action !== 'restore') throw new Error('audio_storage_referenced')
        if (this.options.isWriting(NAME.exec(f.name)![1])) throw new Error('audio_storage_busy')
        if (action === 'recycle') {
          if (Math.max(f.stamp.mtimeMs,f.stamp.ctimeMs) > this.now() - DAY) throw new Error('audio_storage_file_changed')
          this.save(f.key,{name:f.name,stamp:f.stamp,phase:'moving'})
          this.finish(f.key,{name:f.name,stamp:f.stamp,phase:'moving'})
        } else if (action === 'erase') {
          this.save(f.key,{name:f.name,stamp:f.stamp,phase:'erasing'})
          this.finish(f.key,{name:f.name,stamp:f.stamp,phase:'erasing'})
        } else {
          if (f.recycled) {
            this.save(f.key,{name:f.name,stamp:f.stamp,phase:'restoring'})
            this.finish(f.key,{name:f.name,stamp:f.stamp,phase:'restoring'})
          }
          if (action === 'recover') AudioStorageRepo.recover(NAME.exec(f.name)![1], f.recycled ? join(this.directory,f.name) : path,f.modifiedAt)
        }
        result.completed++; result.bytes += f.bytes
      } catch (error) { result.failed.push({name:f.name,detail:(error as Error).message}) }
    }
    this.review = null
    this.options.changed()
    return result
  }
}
