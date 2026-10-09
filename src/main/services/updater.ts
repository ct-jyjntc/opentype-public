import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { AppUpdater, UpdateCheckResult } from 'electron-updater'
import type { UpdateState } from '../../shared/updater'

class DesktopUpdater {
  private state: UpdateState = { phase: 'idle', channel: 'stable' }
  private engine?: Promise<AppUpdater>
  private checked?: UpdateCheckResult
  private busy = false
  private cancelled = false
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
      // autoUpdater is a lazy CommonJS getter, not a Node ESM named export.
      const { autoUpdater } = updaterModule
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.logger = null
      autoUpdater.setFeedURL({ provider: 'github', owner: 'ct-jyjntc', repo: 'opentype-public' })
      autoUpdater.on('error', () => { if (!this.busy) this.publish({ phase:'error', message:'更新安装未能完成，请前往发布页下载安装。' }) })
      autoUpdater.on('download-progress', progress => {
        if (!this.cancelled && this.state.phase === 'downloading') this.publish({ percent: Math.min(100,Math.max(0,progress.percent)), transferred:progress.transferred, total:progress.total })
      })
      return autoUpdater
    })
  }
  async check(channel = this.state.channel): Promise<UpdateState> {
    if (!['stable','beta'].includes(channel)) throw new Error('invalid_config')
    if (this.busy) return this.snapshot()
    if (this.state.phase === 'ready' && channel === this.state.channel) return this.snapshot()
    this.saveChannel(channel)
    this.checked = undefined
    this.publish({ phase: 'checking', channel, version:undefined, releaseNotes:undefined, percent:undefined, transferred:undefined, total:undefined, message:undefined })
    if (!app.isPackaged || !['darwin','win32','linux'].includes(process.platform)) return this.publish({ phase:'unavailable', message:'开发环境不安装更新，请使用已安装的发行版或前往发布页。' })
    this.busy = true
    try {
      const engine = await this.getEngine()
      engine.allowPrerelease = channel === 'beta'; engine.allowDowngrade = false
      const result = await engine.checkForUpdates()
      if (!result) return this.publish({ phase:'unavailable', message:'此安装方式暂不支持自动更新，请前往发布页。' })
      this.checked = result
      const notes = result.updateInfo.releaseNotes
      return this.publish({ phase:result.isUpdateAvailable?'available':'current', version:result.updateInfo.version,
        releaseNotes: typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.map(n=>`${n.version}\n${n.note}`).join('\n\n') : undefined })
    } catch { return this.publish({ phase:'error', message:'无法检查更新。请检查网络，或前往官方发布页查看。' }) }
    finally { this.busy = false }
  }
  async download(): Promise<UpdateState> {
    if (this.busy || this.state.phase !== 'available' || !this.checked?.isUpdateAvailable) return this.snapshot()
    this.busy = true; this.cancelled = false
    this.publish({ phase:'downloading', percent:0, message:undefined })
    try {
      const engine = await this.getEngine()
      await engine.downloadUpdate(this.checked.cancellationToken)
      if (this.cancelled) return this.publish({ phase:'cancelled', message:'下载已取消，可重新检查更新。' })
      return this.publish({ phase:'ready', percent:100, message:'更新已下载并通过发行包校验，点击重启安装。' })
    } catch {
      return this.publish({ phase:this.cancelled?'cancelled':'error', message:this.cancelled?'下载已取消，可重新检查更新。':'更新下载或校验失败。当前版本保持可用，可前往发布页下载安装。' })
    } finally { this.busy = false }
  }
  cancel() {
    if (this.state.phase === 'downloading') { this.cancelled = true; this.checked?.cancellationToken?.cancel() }
    return this.snapshot()
  }
  async install() {
    if (this.state.phase !== 'ready' || this.busy) throw new Error('更新尚未准备好')
    if (!this.canInstall()) throw new Error('请先结束正在进行的录音或文字处理，再安装更新')
    const engine = await this.getEngine()
    engine.quitAndInstall(false, true)
  }
}
export const desktopUpdater = new DesktopUpdater()
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
