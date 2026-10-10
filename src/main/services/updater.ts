import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { AppUpdater, UpdateCheckResult, UpdateDownloadedEvent } from 'electron-updater'
import { createHash, randomBytes } from 'node:crypto'
import { access, constants, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import type { UpdateState } from '../../shared/updater'

// Electron patches node:fs to expose app.asar as a virtual filesystem. The
// updater needs the physical archive bytes here, so use Electron's unpatched fs.
const asarFs = require('original-fs') as typeof import('node:fs')
const execFileAsync = promisify(execFile)
const APP_ID = 'dev.opentype.desktop'
// The app gives up on quitting first; the helper must wait strictly longer and
// is terminated by the app's fallback, so it never installs after a cancel.
const APP_QUIT_FALLBACK_MS = 65_000
const HELPER_EXIT_WAIT_MS = 90_000
const STALE_STAGE_MS = 3600_000
const STALE_BACKUP_MS = 7 * 24 * 3600_000
type PreparedInstall = { appPath: string; stageRoot: string; stagedApp: string; parentPath: string; version: string; sha512: string; candidateIdentity: string; startupConfirmation: boolean }

async function command(file: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  return execFileAsync(file, args, { encoding: 'utf8', maxBuffer, timeout: 30_000 })
}
async function sha512(file: string) {
  const hash = createHash('sha512')
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(file)
    input.on('error', reject); hash.on('error', reject); hash.on('finish', resolvePromise); input.pipe(hash)
  })
  return hash.digest('base64')
}
function asarPackageVersion(asarPath: string): string {
  const fd = asarFs.openSync(asarPath, 'r')
  try {
    const fileSize = asarFs.fstatSync(fd).size
    const prefix = Buffer.alloc(16)
    if (asarFs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) throw new Error('更新包缺少有效的应用版本信息')
    const pickleSize = prefix.readUInt32LE(4)
    if (pickleSize < 8 || pickleSize > 32 * 1024 * 1024 || 8 + pickleSize > fileSize) throw new Error('更新包应用信息格式无效')
    const lengthWord = Buffer.alloc(4)
    if (asarFs.readSync(fd, lengthWord, 0, 4, 12) !== 4) throw new Error('更新包应用信息格式无效')
    const jsonSize = lengthWord.readUInt32LE(0)
    if (jsonSize < 2 || jsonSize > pickleSize - 4) throw new Error('更新包应用信息格式无效')
    const headerBuf = Buffer.alloc(jsonSize)
    if (asarFs.readSync(fd, headerBuf, 0, jsonSize, 16) !== jsonSize) throw new Error('更新包应用信息格式无效')
    const header = JSON.parse(headerBuf.toString('utf8')) as { files?: Record<string, { size?: number; offset?: string }> }
    const entry = header.files?.['package.json']
    if (!entry || !Number.isSafeInteger(entry.size) || typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) throw new Error('更新包缺少应用版本信息')
    const start = 8 + pickleSize + Number(entry.offset), end = start + Number(entry.size)
    if (!Number.isSafeInteger(end) || start < 8 + pickleSize || end > fileSize || Number(entry.size) > 1024 * 1024) throw new Error('更新包应用版本信息超出文件范围')
    const content = Buffer.alloc(Number(entry.size))
    if (asarFs.readSync(fd, content, 0, content.length, start) !== content.length) throw new Error('更新包应用版本信息不完整')
    const pkg = JSON.parse(content.toString('utf8')) as { version?: unknown }
    if (typeof pkg.version !== 'string') throw new Error('更新包版本无效')
    return pkg.version
  } finally { asarFs.closeSync(fd) }
}
function inspectZip(zipPath: string) {
  const fd = openSync(zipPath, 'r')
  try {
    const fileSize = fstatSync(fd).size
    const tailSize = Math.min(fileSize, 65_557), tail = Buffer.alloc(tailSize)
    readSync(fd, tail, 0, tailSize, fileSize - tailSize)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
    if (eocd < 0) throw new Error('更新 ZIP 目录损坏')
    const totalEntries = tail.readUInt16LE(eocd + 10), dirSize = tail.readUInt32LE(eocd + 12), dirOffset = tail.readUInt32LE(eocd + 16)
    if (totalEntries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff || dirSize > 32 * 1024 * 1024 || dirOffset + dirSize > fileSize) throw new Error('更新 ZIP 使用了不支持的目录格式')
    const dir = Buffer.alloc(dirSize)
    if (readSync(fd, dir, 0, dirSize, dirOffset) !== dirSize) throw new Error('更新 ZIP 目录不完整')
    const decoder = new TextDecoder('utf-8', { fatal:true }), seen = new Set<string>(), entries: string[] = [], links: Array<{ name:string; target:string }> = []
    let cursor = 0
    for (let index = 0; index < totalEntries; index++) {
      if (cursor + 46 > dir.length || dir.readUInt32LE(cursor) !== 0x02014b50) throw new Error('更新 ZIP 目录损坏')
      const madeBy = dir.readUInt16LE(cursor + 4) >>> 8, flags = dir.readUInt16LE(cursor + 8), method = dir.readUInt16LE(cursor + 10)
      const compressedSize = dir.readUInt32LE(cursor + 20), uncompressedSize = dir.readUInt32LE(cursor + 24)
      const nameLen = dir.readUInt16LE(cursor + 28), extraLen = dir.readUInt16LE(cursor + 30), commentLen = dir.readUInt16LE(cursor + 32)
      const attrs = dir.readUInt32LE(cursor + 38), localOffset = dir.readUInt32LE(cursor + 42), end = cursor + 46 + nameLen + extraLen + commentLen
      if (end > dir.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || (flags & 1)) throw new Error('更新 ZIP 条目格式无效')
      const rawName = dir.subarray(cursor + 46, cursor + 46 + nameLen)
      if (!(flags & 0x800) && rawName.some(byte => byte > 0x7f)) throw new Error('更新 ZIP 包含无法安全解码的路径')
      const name = decoder.decode(rawName)
      if (!name || /[\u0000-\u001f\u007f\\:]/.test(name) || name.startsWith('/') || name.includes('//') || name.split('/').some(part => part === '.' || part === '..')) throw new Error('更新 ZIP 包含不安全的文件路径')
      const normalized = name.replace(/\/$/, '').normalize('NFC').toLocaleLowerCase('en-US')
      if (seen.has(normalized)) throw new Error('更新 ZIP 包含重复路径')
      seen.add(normalized); entries.push(name)
      const mode = madeBy === 3 ? attrs >>> 16 : 0
      if (name.replace(/\/$/, '') === 'OpenType.app' && (mode & 0xf000) === 0xa000) throw new Error('更新 ZIP 应用目录不能是符号链接')
      const local = Buffer.alloc(30)
      if (readSync(fd, local, 0, 30, localOffset) !== 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('更新 ZIP 本地条目损坏')
      const localFlags = local.readUInt16LE(6), localMethod = local.readUInt16LE(8), localNameLen = local.readUInt16LE(26), localExtraLen = local.readUInt16LE(28)
      const localName = Buffer.alloc(localNameLen)
      if (readSync(fd, localName, 0, localNameLen, localOffset + 30) !== localNameLen || !localName.equals(rawName) || localMethod !== method || localFlags !== flags) throw new Error('更新 ZIP 本地路径与目录不一致')
      const dataOffset = localOffset + 30 + localNameLen + localExtraLen
      if (dataOffset + compressedSize > dirOffset) throw new Error('更新 ZIP 条目数据范围无效')
      if ((mode & 0xf000) === 0xa000) {
        if (uncompressedSize > 4096 || (method !== 0 && method !== 8)) throw new Error('更新 ZIP 符号链接格式无效')
        const compressed = Buffer.alloc(compressedSize)
        if (readSync(fd, compressed, 0, compressedSize, dataOffset) !== compressedSize) throw new Error('更新 ZIP 符号链接数据不完整')
        const linkBytes = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength:4096 })
        const target = decoder.decode(linkBytes)
        if (!target || /[\u0000-\u001f\u007f\\]/.test(target) || posix.isAbsolute(target) || /^[a-zA-Z]:/.test(target) || target.includes('//') || target.split('/').includes('..')) throw new Error('更新 ZIP 包含不安全的符号链接')
        links.push({ name, target })
      }
      cursor = end
    }
    if (cursor !== dir.length) throw new Error('更新 ZIP 目录包含多余数据')
    const roots = new Set(entries.map(name => name.split('/')[0]).filter(name => name.endsWith('.app')))
    if (roots.size !== 1) throw new Error('更新 ZIP 必须只包含一个应用目录')
    const root = [...roots][0]
    if (root !== 'OpenType.app' || entries.some(name => name !== root && !name.startsWith(`${root}/`))) throw new Error('更新 ZIP 应用目录结构无效')
    const linkMap = new Map(links.map(({ name, target }) => [name, target]))
    const resolveLink = (name: string, active = new Set<string>(), depth = 0): string[] => {
      if (depth > 64 || active.has(name)) throw new Error('更新 ZIP 符号链接存在循环')
      const target = linkMap.get(name)
      if (target === undefined) return name.split('/').slice(1)
      const nextActive = new Set(active); nextActive.add(name)
      const base = posix.dirname(name).split('/').slice(1)
      const pending = [...base, ...target.split('/')]
      const stack: string[] = []
      for (let index = 0; index < pending.length; index++) {
        const part = pending[index]
        if (!part || part === '.') continue
        if (part === '..') {
          if (!stack.length) throw new Error('更新 ZIP 符号链接指向应用目录外')
          stack.pop(); continue
        }
        const candidate = `${root}/${[...stack, part].join('/')}`
        if (linkMap.has(candidate)) {
          const resolved = resolveLink(candidate, nextActive, depth + 1)
          stack.length = 0; stack.push(...resolved)
        } else stack.push(part)
      }
      return stack
    }
    for (const { name } of links) resolveLink(name)
    return root
  } finally { closeSync(fd) }
}
async function insideBundleNoEscape(root: string) {
  const canonicalRoot = await realpath(root)
  const walk = async (dir: string): Promise<void> => {
    for (const name of await (await import('node:fs/promises')).readdir(dir)) {
      const file = join(dir, name), info = await lstat(file)
      if (info.isSymbolicLink()) {
        const target = await realpath(file)
        if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) throw new Error('更新包包含指向应用目录外的符号链接')
      } else if (info.isDirectory()) await walk(file)
    }
  }
  await walk(canonicalRoot)
}
async function appInfo(appPath: string) {
  const plist = join(appPath, 'Contents', 'Info.plist')
  const { stdout: bundleId } = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])
  const { stdout: executable } = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])
  const { stdout: shortVersion } = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])
  const { stdout: bundleVersion } = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist])
  const packageVersion = asarPackageVersion(join(appPath, 'Contents', 'Resources', 'app.asar'))
  const arch = (await command('/usr/bin/lipo', ['-archs', join(appPath, 'Contents', 'MacOS', executable.trim())])).stdout.trim().split(/\s+/)
  return { bundleId: bundleId.trim(), shortVersion: shortVersion.trim(), bundleVersion: bundleVersion.trim(), packageVersion, arch }
}
async function signatureIdentity(appPath: string) {
  try {
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/code object is not signed at all|no code signature found/i.test(detail)) return 'unsigned'
    throw new Error(`应用签名完整性检查失败：${detail.slice(0, 500)}`)
  }
  try {
    const { stdout, stderr } = await command('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
    const text = `${stdout}\n${stderr}`
    if (/^Signature=adhoc\s*$/m.test(text)) return 'adhoc'
    const team = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
    const authority = text.match(/^Authority=(.+)$/m)?.[1]?.trim()
    return team ? `team:${team}` : authority ? `authority:${authority}` : 'unsigned'
  } catch { return 'unsigned' }
}
async function validateBundle(appPath: string, expectedVersion: string, currentIdentity: string, allowAdhoc: boolean) {
  const info = await appInfo(appPath)
  if (info.bundleId !== APP_ID) throw new Error('更新包应用身份不匹配')
  if (info.packageVersion !== expectedVersion) throw new Error(`更新包版本不匹配（元数据 ${expectedVersion}，应用 ${info.packageVersion}）`)
  if (!info.shortVersion || !info.bundleVersion) throw new Error('更新包缺少显示版本信息')
  const hostArch = (await command('/usr/sbin/sysctl', ['-in', 'hw.optional.arm64'])).stdout.trim() === '1' ? 'arm64' : 'x86_64'
  if (!info.arch.includes(hostArch)) throw new Error(`此更新包不支持当前 Mac（需要 ${hostArch}）`)
  const identity = await signatureIdentity(appPath)
  if (allowAdhoc) {
    if (identity !== 'adhoc' || !['adhoc', 'unsigned'].includes(currentIdentity)) throw new Error('更新包必须是通过完整性验证的 ad-hoc 签名版本')
  } else if (identity !== currentIdentity) throw new Error('更新包签名身份与当前应用不匹配')
  return identity
}
// Cheap install eligibility only; bundle/signature verification runs at download time.
async function macAppRoot() {
  const appRoot = await realpath(resolve(dirname(process.execPath), '..', '..'))
  if (appRoot.includes('/AppTranslocation/')) throw new Error('当前应用位于 macOS 临时隔离位置，请将 OpenType 移入“应用程序”文件夹后再更新。')
  if (!appRoot.endsWith('.app') || !existsSync(join(appRoot, 'Contents', 'Info.plist'))) throw new Error('无法确定当前应用位置，请将 OpenType 移入“应用程序”文件夹后再更新。')
  const parentPath = await realpath(dirname(appRoot))
  try { await access(parentPath, constants.W_OK) } catch { throw new Error('当前应用目录没有写入权限，请移入“应用程序”文件夹或检查权限。') }
  return { appRoot, parentPath }
}
async function validateCurrentBundle(appPath: string, expected: { packageVersion:string; bundleVersion:string }, identity: string) {
  const info = await appInfo(appPath)
  if (info.bundleId !== APP_ID || info.packageVersion !== expected.packageVersion || info.bundleVersion !== expected.bundleVersion) throw new Error('当前应用在下载期间发生变化，请重新检查更新。')
  const currentIdentity = await signatureIdentity(appPath)
  if (currentIdentity !== identity) throw new Error('当前应用签名身份在下载期间发生变化，请重新检查更新。')
}

class DesktopUpdater {
  private state: UpdateState = { phase: 'idle', channel: 'stable' }
  private engine?: Promise<AppUpdater>
  private checked?: UpdateCheckResult
  private busy = false
  private cancelled = false
  private installBusy = false
  private downloadedFile?: string
  private prepared?: PreparedInstall
  private currentIdentity?: string
  private currentBundleVersion?: string
  private currentPackageVersion?: string
  private canInstall = () => false
  private saveChannel = (_channel: 'stable'|'beta') => {}
  configure(options: { channel: 'stable'|'beta'; saveChannel: (channel: 'stable'|'beta') => void; canInstall: () => boolean }) {
    this.state.channel = options.channel; this.canInstall = options.canInstall; this.saveChannel = options.saveChannel
  }
  snapshot() { return { ...this.state } }
  private publish(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch }
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('desktop:update-state', this.snapshot())
    return this.snapshot()
  }
  private getEngine() {
    return this.engine ??= import('electron-updater').then(({ default: updaterModule }) => {
      const { autoUpdater } = updaterModule
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.logger = null
      autoUpdater.setFeedURL({ provider: 'github', owner: 'ct-jyjntc', repo: 'opentype-public' })
      autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => { this.downloadedFile = event.downloadedFile })
      autoUpdater.on('error', error => {
        if (this.installBusy || this.state.phase === 'installing') {
          this.installBusy = false
          this.publish({ phase:'error', message:`系统更新程序安装失败：${String(error?.message ?? error).slice(0, 300)}。当前应用仍可使用，请前往发布页下载安装。` })
        } else if (!this.busy) this.publish({ phase:'error', message:`更新安装失败：${String(error?.message ?? error).slice(0, 300)}。请前往发布页下载安装。` })
      })
      autoUpdater.on('download-progress', progress => {
        if (!this.cancelled && this.state.phase === 'downloading') this.publish({ percent: Math.min(100,Math.max(0,progress.percent)), transferred:progress.transferred, total:progress.total })
      })
      return autoUpdater
    })
  }
  async check(channel = this.state.channel): Promise<UpdateState> {
    if (!['stable','beta'].includes(channel)) throw new Error('invalid_config')
    if (this.busy || this.installBusy) return this.snapshot()
    if (this.state.phase === 'ready' && channel === this.state.channel) return this.snapshot()
    this.saveChannel(channel)
    this.checked = undefined; this.downloadedFile = undefined
    if (this.prepared) { await rm(this.prepared.stageRoot, { recursive:true, force:true }); this.prepared = undefined }
    this.currentIdentity = undefined; this.currentBundleVersion = undefined; this.currentPackageVersion = undefined
    this.publish({ phase: 'checking', channel, version:undefined, releaseNotes:undefined, percent:undefined, transferred:undefined, total:undefined, message:undefined })
    if (!app.isPackaged || !['darwin','win32','linux'].includes(process.platform)) return this.publish({ phase:'unavailable', message:'开发环境不安装更新，请使用已安装的发行版或前往发布页。' })
    this.busy = true
    try {
      if (process.platform === 'darwin') await macAppRoot()
      const engine = await this.getEngine()
      engine.allowPrerelease = channel === 'beta'; engine.allowDowngrade = false
      const result = await engine.checkForUpdates()
      if (!result) return this.publish({ phase:'unavailable', message:'此安装方式暂不支持自动更新，请前往发布页。' })
      this.checked = result
      const notes = result.updateInfo.releaseNotes
      return this.publish({ phase:result.isUpdateAvailable?'available':'current', version:result.updateInfo.version,
        releaseNotes: typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.map(n=>`${n.version}\n${n.note}`).join('\n\n') : undefined })
    } catch (error) { return this.publish({ phase:'error', message:`无法检查更新：${String(error instanceof Error ? error.message : error).slice(0, 300)}` }) }
    finally { this.busy = false }
  }
  // Heavy current-bundle verification (PlistBuddy, lipo, asar, codesign) runs
  // before downloading so a failure never blocks merely checking for updates.
  private async verifyCurrentMacBundle() {
    const { appRoot } = await macAppRoot()
    const info = await appInfo(appRoot)
    if (info.bundleId !== APP_ID) throw new Error('当前应用身份不匹配')
    const identity = await signatureIdentity(appRoot)
    this.currentBundleVersion = info.bundleVersion; this.currentPackageVersion = info.packageVersion; this.currentIdentity = identity
  }
  // Surfaces the previous helper run once; rollbackPending results are kept
  // (renamed) so the startup sweep never deletes the referenced backup.
  restoreLastInstallResult(installDir: string) {
    const resultPath = join(installDir, 'last-result.json')
    let result: { ok?: unknown; cancelled?: unknown; rollbackPending?: unknown; error?: unknown; backupPath?: unknown }
    try {
      const info = lstatSync(resultPath)
      if (!info.isFile() || info.size > 64 * 1024) { rmSync(resultPath, { force:true }); return }
      result = JSON.parse(readFileSync(resultPath, 'utf8')) as typeof result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') try { rmSync(resultPath, { force:true }) } catch {}
      return
    }
    const pending = result.rollbackPending === true
    try {
      if (pending) renameSync(resultPath, join(installDir, `rollback-pending-${Date.now()}.json`))
      else rmSync(resultPath, { force:true })
    } catch { return }
    // Cancelled installs (app did not quit) were already reported in the running app.
    if (result.ok !== false || (result.cancelled === true && !pending)) return
    const reason = (typeof result.error === 'string' && result.error.trim() ? result.error.trim() : '未知原因').replace(/[，,]\s*正在恢复旧版本$/, '').slice(0, 300)
    const backupPath = typeof result.backupPath === 'string' ? result.backupPath : undefined
    this.publish({ phase:'error', message: pending
      ? `上次更新未完成：${reason}。旧版本已备份在 ${backupPath ?? '应用目录'}，如当前版本异常可手动恢复。`
      : `上次更新未完成：${reason}，已保留当前版本。` })
  }
  private async prepareMacInstall(update: UpdateDownloadedEvent) {
    const files = this.checked?.updateInfo.files ?? []
    const zip = files.find(file => file.url.toLowerCase().endsWith('.zip'))
    if (!zip?.sha512) throw new Error('发布元数据缺少 ZIP 的 SHA-512 校验值')
    const downloaded = update.downloadedFile
    if (!downloaded || !existsSync(downloaded)) throw new Error('找不到已下载的更新 ZIP')
    if (await sha512(downloaded) !== zip.sha512) throw new Error('更新 ZIP 的 SHA-512 校验失败')
    const { appRoot, parentPath } = await macAppRoot()
    const identity = this.currentIdentity ?? await signatureIdentity(appRoot)
    const currentInfo = await appInfo(appRoot)
    if (currentInfo.bundleId !== APP_ID || currentInfo.bundleVersion !== this.currentBundleVersion || currentInfo.packageVersion !== this.currentPackageVersion) throw new Error('当前应用在下载期间发生变化，请重新检查更新。')
    const probe = join(parentPath, `.opentype-write-${randomBytes(8).toString('hex')}`)
    try { await writeFile(probe, ''); await rm(probe) } catch { throw new Error('当前应用目录不可写（可能是只读磁盘映像），请先移入“应用程序”文件夹。') }
    const stageRoot = await mkdtemp(join(parentPath, '.opentype-update-'))
    try {
      const root = inspectZip(downloaded)
      await command('/usr/bin/ditto', ['-x', '-k', downloaded, stageRoot])
      const stagedApp = join(stageRoot, root)
      await insideBundleNoEscape(stagedApp)
      const candidateIdentity = await validateBundle(stagedApp, this.checked!.updateInfo.version, identity, ['adhoc','unsigned'].includes(identity))
      const startupConfirmation = existsSync(join(stagedApp, 'Contents', 'Resources', 'update-installer-helper.cjs'))
      const prepared = { appPath: appRoot, stageRoot, stagedApp, parentPath, version: this.checked!.updateInfo.version, sha512: zip.sha512, candidateIdentity, startupConfirmation }
      if (!['adhoc','unsigned'].includes(identity)) { await rm(stageRoot, { recursive:true, force:true }); return undefined }
      return prepared
    } catch (error) { await rm(stageRoot, { recursive:true, force:true }); throw error }
  }
  async download(): Promise<UpdateState> {
    if (this.busy || this.installBusy || this.state.phase !== 'available' || !this.checked?.isUpdateAvailable) return this.snapshot()
    this.busy = true; this.cancelled = false; this.downloadedFile = undefined
    this.publish({ phase:'downloading', percent:0, message:undefined })
    try {
      if (process.platform === 'darwin') await this.verifyCurrentMacBundle()
      const engine = await this.getEngine()
      await engine.downloadUpdate(this.checked.cancellationToken)
      if (this.cancelled) return this.publish({ phase:'cancelled', message:'下载已取消，可重新检查更新。' })
      if (process.platform === 'darwin') {
        if (!this.downloadedFile) throw new Error('下载完成但更新包未通过完整性检查，请重新下载。')
        this.prepared = await this.prepareMacInstall({ ...this.checked.updateInfo, downloadedFile:this.downloadedFile })
        if (this.cancelled) {
          if (this.prepared) await rm(this.prepared.stageRoot, { recursive:true, force:true })
          this.prepared = undefined
          return this.publish({ phase:'cancelled', message:'下载已取消，可重新检查更新。' })
        }
      }
      return this.publish({ phase:'ready', percent:100, message:this.prepared ? '更新包已完成完整性、应用身份、版本和兼容性检查，可以安装。' : '更新已下载并通过完整性校验，点击重启安装。' })
    } catch (error) {
      this.prepared = undefined
      return this.publish({ phase:this.cancelled?'cancelled':'error', message:this.cancelled?'下载已取消，可重新检查更新。':`更新下载或验证失败：${String(error instanceof Error ? error.message : error).slice(0, 300)}` })
    } finally { this.busy = false }
  }
  cancel() {
    if (this.state.phase === 'downloading') { this.cancelled = true; this.checked?.cancellationToken?.cancel() }
    return this.snapshot()
  }
  async install() {
    if (this.installBusy) throw new Error('更新正在安装')
    if (this.state.phase !== 'ready') throw new Error('更新尚未准备好')
    if (!this.canInstall()) throw new Error('请先结束正在进行的录音或文字处理，再安装更新')
    this.installBusy = true
    if (this.prepared && process.platform === 'darwin') {
      let configPath: string | undefined
      let child: import('node:child_process').ChildProcess | undefined
      try {
        await validateCurrentBundle(this.prepared.appPath, { packageVersion:this.currentPackageVersion!, bundleVersion:this.currentBundleVersion! }, this.currentIdentity ?? 'unsigned')
        const helperPath = join(process.resourcesPath, 'update-installer-helper.cjs')
        const tempBase = join(app.getPath('userData'), 'update-install')
        await mkdir(tempBase, { recursive:true, mode:0o700 })
        const canonicalTempBase = await realpath(tempBase)
        const resultPath = join(canonicalTempBase, 'last-result.json'), logPath = join(canonicalTempBase, 'install.log')
        configPath = join(canonicalTempBase, `install-${randomBytes(12).toString('hex')}.json`)
        const confirmToken = randomBytes(16).toString('hex'), markerPath = this.prepared.startupConfirmation ? join(canonicalTempBase, `confirm-${confirmToken}.json`) : undefined
        const relaunchArgs = app.commandLine.getSwitchValue('user-data-dir')
        await writeFile(configPath, JSON.stringify({ ...this.prepared, pid:process.pid, timeoutMs:HELPER_EXIT_WAIT_MS, resultPath, logPath,
          currentIdentity:this.currentIdentity, confirmToken, markerPath, userDataPath:app.getPath('userData'),
          relaunchArgs: [...(relaunchArgs ? [`--user-data-dir=${relaunchArgs}`] : []), ...(markerPath ? [`--update-install-confirm-path=${markerPath}`] : []), `--update-install-confirm-token=${confirmToken}`] }), { mode:0o600, flag:'wx' })
        const { spawn } = await import('node:child_process')
        const startedChild = spawn(process.execPath, [helperPath, configPath], { detached:true, stdio:['ignore','pipe','pipe'], env:{ ...process.env, ELECTRON_RUN_AS_NODE:'1' } })
        child = startedChild
        await new Promise<void>((resolvePromise, reject) => {
          let output = ''
          const timeout = setTimeout(() => reject(new Error('更新安装器启动超时')), 30_000)
          startedChild.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8')
            if (output.includes('READY\n')) { clearTimeout(timeout); resolvePromise() }
          })
          startedChild.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8').slice(0, 1000) })
          startedChild.once('error', error => { clearTimeout(timeout); reject(error) })
          startedChild.once('exit', code => { if (!output.includes('READY\n')) { clearTimeout(timeout); reject(new Error(`更新安装器无法启动（${output.slice(0, 300) || code}）`)) } })
        })
        child.unref()
        const stageRoot = this.prepared.stageRoot
        this.prepared = undefined
        this.publish({ phase:'installing', message:'正在退出应用并安装更新…' })
        setTimeout(() => {
          if (app.isReady() && this.state.phase === 'installing') {
            // We are still running, so the helper is still waiting for us to exit:
            // stop it before removing the staged copy it would otherwise install.
            try { startedChild.kill('SIGTERM') } catch {}
            void rm(stageRoot, { recursive:true, force:true })
            this.installBusy = false
            this.publish({ phase:'error', message:'应用未能正常退出，安装已取消。请关闭应用后重试。' })
          }
        }, APP_QUIT_FALLBACK_MS).unref()
        app.quit()
        return
      } catch (error) {
        child?.kill()
        if (configPath) await rm(configPath, { force:true })
        if (this.prepared) { await rm(this.prepared.stageRoot, { recursive:true, force:true }); this.prepared = undefined }
        this.installBusy = false
        this.publish({ phase:'error', message:`无法启动更新安装器：${String(error instanceof Error ? error.message : error).slice(0, 300)}` })
        throw error
      }
    }
    try {
      this.publish({ phase:'installing', message:'正在启动系统更新程序…' })
      const engine = await this.getEngine()
      engine.quitAndInstall(false, true)
    } catch (error) {
      if (this.prepared) { await rm(this.prepared.stageRoot, { recursive:true, force:true }); this.prepared = undefined }
      this.installBusy = false
      this.publish({ phase:'error', message:`无法启动系统更新程序：${String(error instanceof Error ? error.message : error).slice(0, 300)}` })
      throw error
    }
  }
}
export const desktopUpdater = new DesktopUpdater()

function pendingRollbackBackups(installDir: string) {
  const paths = new Set<string>()
  try {
    for (const name of readdirSync(installDir)) {
      if (!/^rollback-pending-\d+\.json$/.test(name)) continue
      try {
        const value = (JSON.parse(readFileSync(join(installDir, name), 'utf8')) as { backupPath?: unknown }).backupPath
        if (typeof value === 'string') paths.add(value)
      } catch {}
    }
  } catch {}
  return paths
}
// Removes leftovers of interrupted installs next to the app: staged copies
// (>1 h) and backups (>7 d) owned by this user. Never follows symlinks and
// uses original-fs so app.asar inside them is treated as a plain file.
async function sweepStaleUpdateArtifacts(installDir: string) {
  const uid = process.getuid?.()
  if (uid === undefined) return
  const appRoot = asarFs.realpathSync(resolve(dirname(process.execPath), '..', '..'))
  if (!appRoot.endsWith('.app') || appRoot.includes('/AppTranslocation/')) return
  const parentPath = dirname(appRoot), keep = pendingRollbackBackups(installDir)
  keep.add(appRoot)
  const now = Date.now()
  for (const name of await asarFs.promises.readdir(parentPath)) {
    const stage = /^\.opentype-update-[A-Za-z0-9]{6}$/.test(name)
    const backup = /^\.opentype-backup-\d+-(\d+)\.app$/.exec(name)
    if (!stage && !backup) continue
    const file = join(parentPath, name)
    try {
      const info = await asarFs.promises.lstat(file)
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || keep.has(file)) continue
      const touched = Math.max(info.mtimeMs, info.ctimeMs, backup ? Number(backup[1]) : 0)
      if (now - touched < (stage ? STALE_STAGE_MS : STALE_BACKUP_MS)) continue
      await asarFs.promises.rm(file, { recursive:true, force:true })
    } catch {}
  }
  // Confirmation markers a slow (unconfirmed) launch wrote after the helper stopped waiting.
  let markers: string[] = []
  try { markers = readdirSync(installDir) } catch {}
  for (const name of markers) {
    if (!/^confirm-[a-f0-9]{32}\.json$/.test(name)) continue
    try {
      const file = join(installDir, name), info = lstatSync(file)
      if (info.isFile() && now - info.mtimeMs > STALE_STAGE_MS) rmSync(file, { force:true })
    } catch {}
  }
}
// Called once at startup. Install-confirmation launches skip it: the helper is
// still running and owns last-result.json and the staged/backup directories.
export function recoverUpdateInstall(confirmationLaunch: boolean) {
  if (confirmationLaunch || process.platform !== 'darwin' || !app.isPackaged) return
  // The install dir may not exist (e.g. quit after download); the sweep still runs.
  const installDir = join(app.getPath('userData'), 'update-install')
  try { desktopUpdater.restoreLastInstallResult(installDir) } catch (error) { console.warn('[opentype] update result recovery failed:', error) }
  void sweepStaleUpdateArtifacts(installDir).catch(() => {})
}
export function registerUpdater(owner: () => WebContents | undefined) {
  const register = (channel: string, run: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => {
    const expected = owner()
    if (!expected || event.sender !== expected || event.senderFrame !== expected.mainFrame) throw new Error('invalid_update_request')
    return run(...args)
  })
  register('desktop:update-get', () => desktopUpdater.snapshot())
  register('desktop:update-check', channel => desktopUpdater.check(channel))
  register('desktop:update-download', () => desktopUpdater.download())
  register('desktop:update-cancel', () => desktopUpdater.cancel())
  register('desktop:update-install', () => desktopUpdater.install())
}
