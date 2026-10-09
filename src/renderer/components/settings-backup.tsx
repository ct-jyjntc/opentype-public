import { useState } from 'react'
import { errorMessage } from '../../shared/desktop'
import type { BackupPreview } from '../../shared/backup'
import { Modal } from './ui'

export function SettingsBackup({ notify }: { notify:(message:string)=>void }) {
  const [preview,setPreview]=useState<BackupPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [settings,setSettings]=useState(true),[dictionary,setDictionary]=useState(true),[conflict,setConflict]=useState<'keep'|'replace'>('keep')
  const api=window.opentype.desktop.backup
  const run=async(action:()=>Promise<void>)=>{
    setBusy(true);setError('')
    try{await action()}catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  return <section className="settings-backup"><h3 className="section-heading">设置与词典备份</h3>
    <p className="muted">导出偏好、Skills、快捷键和词典，换电脑时导入。不含密钥和历史。</p>
    <div className="skill-toolbar"><button disabled={busy} onClick={()=>void run(async()=>{if(await api.export())notify('备份已导出')})}>导出备份</button>
      <button disabled={busy} onClick={()=>void run(async()=>{const p=await api.preview();setPreview(p);setSettings(true);setDictionary(true);setConflict('keep')})}>从备份恢复</button></div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {preview&&<Modal title="恢复设置与词典" onClose={()=>{if(!busy)setPreview(null)}}><div className="dialog-body">
      <p>{preview.fileName}</p><p className="muted">备份时间：{preview.createdAt||'未知'}</p>
      <label className="backup-choice"><input type="checkbox" checked={settings} disabled={busy} onChange={e=>setSettings(e.target.checked)}/>恢复 {preview.settings} 项写作设置与 {preview.skills} 个 Skill</label>
      <p className="muted">备份里的设置会替换当前设置。</p>
      <label className="backup-choice"><input type="checkbox" checked={dictionary} disabled={busy} onChange={e=>setDictionary(e.target.checked)}/>合并 {preview.words} 条词典：新增 {preview.newWords} 条，{preview.conflicts} 条释义冲突</label>
      <p className="muted">{preview.dictionaryTarget==='account'?'词条会恢复到当前账号词典；开启词库同步后会上传。':'词条会恢复到本机词典。'}</p>
      <label className="field">同词条释义冲突时<select disabled={busy||!dictionary} value={conflict} onChange={e=>setConflict(e.target.value as 'keep'|'replace')}><option value="keep">保留本机释义</option><option value="replace">使用备份释义</option></select></label>
      <p className="muted">合并会保留当前词典里独有的词。</p>
      {error&&<p role="alert" className="inline-error">{error}</p>}
      <div className="dialog-actions"><button disabled={busy} onClick={()=>setPreview(null)}>取消</button><button className="primary" disabled={busy||(!settings&&!dictionary)} onClick={()=>void run(async()=>{
        const r=await api.restore(preview.token,{settings,dictionary,conflict});setPreview(null)
        notify(`${r.settingsRestored?'设置已恢复；':''}词典新增 ${r.added} 条，更新 ${r.updated} 条，保留 ${r.kept} 条`)
      })}>{busy?'正在恢复…':'恢复所选内容'}</button></div>
    </div></Modal>}
  </section>
}
