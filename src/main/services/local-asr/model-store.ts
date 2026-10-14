import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchPublicHttps } from '../public-download'

export const SENSEVOICE_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07'
export const SENSEVOICE_DOWNLOAD_BASE = `https://www.opentype.top/downloads/models/sensevoice-int8/${SENSEVOICE_REVISION}`
export const SENSEVOICE_FILES = [
  { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' }
]
type ModelFile = typeof SENSEVOICE_FILES[number]
export type ModelStatus = { state: 'missing' | 'checking' | 'installing' | 'downloading' | 'ready' | 'error'; downloaded: number; total: number; error?: string }

export class SenseVoiceModelStore {
  status: ModelStatus
  private pending?: Promise<ModelStatus>
  private checking?: Promise<ModelStatus>
  private abort?: AbortController
  private verified = new Map<string, string>()
  constructor(readonly directory: string, private readonly files: readonly ModelFile[] = SENSEVOICE_FILES, private readonly userAgent = 'OpenType') {
    this.status = { state: 'missing', downloaded: 0, total: files.reduce((sum, file) => sum + file.bytes, 0) }
  }

  check(): Promise<ModelStatus> {
    if (this.pending) return Promise.resolve(['installing', 'downloading', 'checking'].includes(this.status.state)
      ? this.status : { ...this.status, state: 'checking' })
    if (this.checking) return this.checking
    // Recheck identities on every poll. Only unchanged files may reuse their checksum.
    const previous = this.status
    this.checking = (async () => {
      let ready = true
      for (const file of this.files) if (!(await this.valid(file))) { ready = false; break }
      this.status = ready
        ? { state: 'ready', downloaded: this.status.total, total: this.status.total }
        : { state: previous.state === 'error' ? 'error' : 'missing', downloaded: 0,
          total: this.status.total, ...(previous.error ? { error: previous.error } : {}) }
      return this.status
    })().finally(() => { this.checking = undefined })
    return this.checking
  }

  /** Explicit user action: prefer the installer copy, download only files unavailable there. */
  install(sourceDirectory?: string): Promise<ModelStatus> {
    return this.run(sourceDirectory, true)
  }
  dispose() { this.abort?.abort() }

  /** Startup never needs a network request. Failures stay visible and can be retried in settings. */
  importBundle(sourceDirectory: string): Promise<ModelStatus> {
    return this.run(sourceDirectory, false)
  }

  private run(sourceDirectory: string | undefined, allowDownload: boolean): Promise<ModelStatus> {
    if (this.pending) return this.pending
    const controller = new AbortController()
    this.abort = controller
    this.pending = (async () => {
      // A check started before installation must settle before any replacement is made.
      await this.checking
      this.status = { state: 'checking', downloaded: 0, total: this.status.total }
      try {
        await mkdir(this.directory, { recursive: true })
        for (const file of this.files) {
          controller.signal.throwIfAborted()
          if (!(await this.valid(file, this.directory, controller.signal))) {
            controller.signal.throwIfAborted()
            if (sourceDirectory && await this.valid(file, sourceDirectory, controller.signal)) {
              this.status = { ...this.status, state: 'installing' }
              const destination = join(this.directory, file.name), part = destination + `.${randomUUID()}.bundle-part`
              try {
                await copyFile(join(sourceDirectory, file.name), part)
                // Source media can change during copying; validate the bytes to be published.
                if (!(await this.valid(file, this.directory, controller.signal, part))) throw new Error('bundled_model_checksum_failed')
                controller.signal.throwIfAborted()
                await rename(part, destination)
              } finally { this.verified.delete(part); await unlink(part).catch(() => {}) }
            } else if (allowDownload) {
              controller.signal.throwIfAborted()
              this.status = { ...this.status, state: 'downloading' }
              await this.download(file, controller.signal)
              continue // download already accounts for these bytes
            } else { throw new Error('bundled_model_checksum_failed') }
          }
          controller.signal.throwIfAborted()
          this.status = { ...this.status, downloaded: this.status.downloaded + file.bytes }
        }
        controller.signal.throwIfAborted()
        this.status = { state: 'ready', downloaded: this.status.total, total: this.status.total }
      } catch {
        this.status = { ...this.status, state: 'error', error: controller.signal.aborted
          ? '模型准备已取消，可以重试。'
          : allowDownload ? '模型准备失败，请检查磁盘空间和网络后重试。'
            : '安装包内的模型未能准备完成，可在此重试。请检查磁盘空间；安装包损坏时需重新下载安装包。' }
      }
      return this.status
    })().finally(() => { this.pending = undefined; this.abort = undefined })
    return this.pending
  }

  private async identity(path: string) {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile()) return undefined
    return { size: info.size, key: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') }
  }

  private async valid(file: ModelFile, directory = this.directory, signal?: AbortSignal, path = join(directory, file.name)): Promise<boolean> {
    try {
      signal?.throwIfAborted()
      const before = await this.identity(path)
      if (!before || before.size !== BigInt(file.bytes)) { this.verified.delete(path); return false }
      if (this.verified.get(path) === before.key) return true
      this.verified.delete(path)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
      if (hash.digest('hex') !== file.sha256 || (await this.identity(path))?.key !== before.key) return false
      this.verified.set(path, before.key)
      return true
    } catch { this.verified.delete(path); return false }
  }

  private async download(file: ModelFile, signal: AbortSignal): Promise<void> {
    const destination = join(this.directory, file.name), part = destination + `.${randomUUID()}.part`
    let handle
    try {
      const response = await fetchPublicHttps(`${SENSEVOICE_DOWNLOAD_BASE}/${file.name}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]), userAgent: this.userAgent
      })
      if (!response.ok || !response.body) throw new Error('download_failed')
      handle = await open(part, 'wx', 0o600)
      const reader = response.body.getReader(), hash = createHash('sha256')
      let received = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > file.bytes) throw new Error('invalid_model_size')
          hash.update(value)
          let offset = 0
          while (offset < value.length) {
            signal.throwIfAborted()
            const { bytesWritten } = await handle.write(value, offset, value.length - offset)
            if (!bytesWritten) throw new Error('model_write_failed')
            offset += bytesWritten
          }
          this.status = { ...this.status, downloaded: this.status.downloaded + value.byteLength }
        }
      } finally { await reader.cancel().catch(() => {}) }
      if (received !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('model_checksum_failed')
      await handle.close(); handle = undefined
      signal.throwIfAborted()
      await rename(part, destination)
    } finally { await handle?.close(); await unlink(part).catch(() => {}) }
  }
}
