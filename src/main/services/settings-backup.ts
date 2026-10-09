import { app, BrowserWindow, dialog, ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { randomUUID, createHash } from 'node:crypto'
import { basename } from 'node:path'
import { readFile, writeFile, stat } from 'node:fs/promises'
import type { Preferences } from '../../shared/desktop'
import type { BackupPreview } from '../../shared/backup'
import { DictionaryRepo } from '../db'
import { dictionaryTermKey } from '../db/dictionary-sync'

// Portable writing preferences only. Credentials, service URLs, account state,
// recordings, device IDs and system launch/Dock switches are deliberately absent.
const keys = ['interactionSounds','audioProcessing','outputAudio','floatingBar','recordingActivation',
  'selectedLanguages','featureShortcutBindings','appearance','personalStyle','usePersonalStyle',
  'learnFromEdits','learnFromInputEdits','outputPreferences','appExpressions','skills'] as const
function portable(value: Preferences | Record<string, unknown>): Partial<Preferences> {
  const result: Record<string, unknown> = {}
  for (const key of keys) if (Object.hasOwn(value,key)) result[key] = value[key]
  // Display IDs and normalized offsets belong to the old computer.
  if (result.floatingBar && typeof result.floatingBar === 'object') {
    const p = result.floatingBar as Preferences['floatingBar']
    result.floatingBar = { placement:p.placement === 'remember' ? 'bottom' : p.placement, showPreview:p.showPreview }
  }
  return result as Partial<Preferences>
}
interface BackupData { preferences: Partial<Preferences>; words: Array<{term:string;pronunciation:string}>; createdAt:string }
export function registerSettingsBackup(deps: {
  owner: () => WebContents | undefined
  preferences: () => Preferences
  updatePreferences: (patch: Partial<Preferences>, preview?: boolean) => Preferences
  busy: () => boolean
}) {
  let pending: { token:string; owner:WebContents; fingerprint:string; data:BackupData; expires:number } | undefined
  const authorize = (event: IpcMainInvokeEvent) => {
    const owner = deps.owner()
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_backup_request')
    return owner
  }
  const snapshot = async () => {
    const scope=DictionaryRepo.scope(),words = await DictionaryRepo.list(scope)
    if(scope!==DictionaryRepo.scope())throw new Error('dictionary_scope_changed')
    return { scope,words, preferences:deps.preferences() }
  }
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  ipcMain.handle('desktop:backup-export', async event => {
    const owner = authorize(event), win = BrowserWindow.fromWebContents(owner)
    const data = await snapshot()
    const serialized = JSON.stringify({format:'opentype-settings',version:1,createdAt:new Date().toISOString(),appVersion:app.getVersion(),preferences:portable(data.preferences),
      words:data.words.map(w=>({term:w.term,pronunciation:w.pronunciation??''}))},null,2)
    if(data.words.length>50_000||Buffer.byteLength(serialized)>32*1024*1024)throw new Error('备份超过 50,000 条词典或 32 MB，请先整理内容')
    const options = { title:'导出设置与词典', defaultPath:`OpenType-settings-${new Date().toISOString().slice(0,10)}.json`, filters:[{name:'OpenType 设置',extensions:['json']}] }
    const result = win ? await dialog.showSaveDialog(win,options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    authorize(event)
    await writeFile(result.filePath, serialized, {mode:0o600})
    return true
  })
  ipcMain.handle('desktop:backup-preview', async event => {
    const owner = authorize(event), win = BrowserWindow.fromWebContents(owner)
    pending = undefined
    const options = { title:'选择 OpenType 设置备份', properties:['openFile' as const], filters:[{name:'OpenType 设置',extensions:['json']}] }
    const result = win ? await dialog.showOpenDialog(win,options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    if ((await stat(result.filePaths[0])).size > 32*1024*1024) throw new Error('备份文件超过 32 MB')
    const buffer = await readFile(result.filePaths[0]); if(buffer.length>32*1024*1024)throw new Error('备份文件超过 32 MB')
    const value = JSON.parse(buffer.toString('utf8'))
    if (!value || value.format !== 'opentype-settings' || value.version !== 1 || !value.preferences || typeof value.preferences !== 'object' || !Array.isArray(value.words) || value.words.length>50_000) throw new Error('不是支持的 OpenType 设置备份')
    const requested = portable(value.preferences)
    const normalized = deps.updatePreferences(requested,true)
    // Retain only fields present in the backup, using exactly the values that
    // the preferences service accepted, so preview and restore agree.
    const preferences: Partial<Preferences> = Object.fromEntries(Object.keys(requested).map(key=>[key,normalized[key as keyof Preferences]]))
    const seen = new Set<string>(), words: BackupData['words'] = value.words.map((w: {term?:unknown;pronunciation?:unknown})=>{
      if (!w || typeof w.term!=='string' || !w.term.trim() || w.term.length>100 || typeof w.pronunciation!=='string' || w.pronunciation.length>100) throw new Error('备份包含无效词条')
      const term=w.term.normalize('NFC').trim(), key=dictionaryTermKey(term)
      if(seen.has(key))throw new Error('备份中存在重复词条');seen.add(key)
      return {term,pronunciation:w.pronunciation.trim()}
    })
    const existing = await snapshot(); authorize(event)
    const byTerm = new Map(existing.words.map(w=>[dictionaryTermKey(w.term),w]))
    const token = randomUUID()
    pending = {token,owner,fingerprint:hash(existing),expires:Date.now()+10*60_000,data:{preferences,words,createdAt:typeof value.createdAt==='string'?value.createdAt.slice(0,80):''}}
    return { token,dictionaryTarget:existing.scope==='local'?'local':'account',fileName:basename(result.filePaths[0]),createdAt:pending.data.createdAt,settings:Object.keys(preferences).length,
      skills:preferences.skills?.items.length??0,words:words.length,newWords:words.filter(w=>!byTerm.has(dictionaryTermKey(w.term))).length,
      conflicts:words.filter(w=>{const old=byTerm.get(dictionaryTermKey(w.term));return old&&(old.pronunciation??'')!==w.pronunciation}).length } satisfies BackupPreview
  })
  ipcMain.handle('desktop:backup-restore', async (event, token:string, options:{settings:boolean;dictionary:boolean;conflict:'keep'|'replace'}) => {
    const owner = authorize(event), current = pending
    if (!current || current.owner!==owner || current.token!==token || current.expires<Date.now()) throw new Error('备份预览已过期，请重新选择文件')
    if (!options || typeof options.settings!=='boolean' || typeof options.dictionary!=='boolean' || !['keep','replace'].includes(options.conflict) || (!options.settings&&!options.dictionary)) throw new Error('invalid_config')
    if (deps.busy()) throw new Error('请先结束录音或文字处理，再恢复设置')
    const existing = await snapshot(); authorize(event)
    if (hash(existing)!==current.fingerprint || pending!==current) throw new Error('设置或词典已经变化，请重新预览备份')
    if (deps.busy()) throw new Error('请先结束录音或文字处理，再恢复设置')
    if (options.settings) deps.updatePreferences(current.data.preferences,true)
    pending=undefined
    let changed=false
    try {
      const result=DictionaryRepo.importPortable(options.dictionary?current.data.words:[],options.conflict,()=>{
        if(options.settings){changed=true;deps.updatePreferences(current.data.preferences)}
      })
      for(const win of BrowserWindow.getAllWindows())win.webContents.send('desktop:dictionary-changed')
      return {...result,settingsRestored:options.settings}
    } catch(error) {
      if(changed){try{deps.updatePreferences({...portable(existing.preferences),floatingBar:existing.preferences.floatingBar})}catch{throw new Error('恢复未完成，词典已回滚；请检查当前设置')}}
      throw error
    }
  })
}
