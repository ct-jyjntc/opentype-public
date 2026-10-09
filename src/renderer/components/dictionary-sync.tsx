import { useEffect, useRef, useState } from 'react'
import type { DictionaryConflict, DictionarySyncStatus, SyncedDictionaryValue } from '../../shared/dictionary-sync'
import { errorMessage } from '../../shared/desktop'
import { Modal, Toggle } from './ui'

const api=window.opentype.desktop.dictionarySync
const describe=(value:SyncedDictionaryValue)=>value.deleted?'已删除':`${value.term}${value.pronunciation?' · '+value.pronunciation:''}`
export function DictionarySyncPanel({notify}:{notify:(text:string)=>void}){
  const [status,setStatus]=useState<DictionarySyncStatus>(),[conflicts,setConflicts]=useState<DictionaryConflict[]>([])
  const [confirm,setConfirm]=useState<'enable'|'copy'|'rebuild'>(),[copy,setCopy]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [selected,setSelected]=useState<DictionaryConflict>()
  const scope=useRef<string>(),sequence=useRef(0)
  useEffect(()=>{
    let alive=true,seen=false
    const receive=(value:DictionarySyncStatus)=>{
      if(!alive)return
      const changed=scope.current!==value.accountScope
      scope.current=value.accountScope;setStatus(value)
      if(changed){setSelected(undefined);setConfirm(undefined);setConflicts([]);setError('')}
      const request=++sequence.current
      if(value.conflicts)void api.conflicts().then(rows=>{if(alive&&request===sequence.current)setConflicts(rows)}).catch(()=>{})
      else setConflicts([])
    }
    const off=api.onState(value=>{seen=true;receive(value)})
    void api.status().then(value=>{if(!seen)receive(value)}).catch(e=>{if(alive)setError(errorMessage(e))})
    return ()=>{alive=false;off();sequence.current++}
  },[])
  const run=async(action:()=>Promise<unknown>)=>{
    const accountScope=scope.current;setBusy(true);setError('')
    try{await action()}catch(e){if(scope.current===accountScope)setError(errorMessage(e))}finally{setBusy(false)}
  }
  if(!status)return error?<p role="alert">{error}</p>:null
  const working=busy||status.phase==='syncing'
  // Nothing to show until there is an account: the local dictionary just works.
  if(!status.account&&status.view!=='account'&&!error)return null
  return <section className="dictionary-sync-panel">
    <div className="dictionary-sync-heading"><strong>{status.view==='account'?'当前使用账号词典':'当前使用本机词典'}</strong>
      {status.joined&&<select aria-label="使用的词典" disabled={working} value={status.view} onChange={e=>void run(()=>api.selectView(e.target.value as 'local'|'account',status.accountScope))}>
        <option value="local">本机词典</option><option value="account">当前账号词典</option>
      </select>}
    </div>
    {status.account?<>
      <div className="dictionary-sync-heading"><span>在此设备自动同步账号词典</span><Toggle label="自动同步账号词典" checked={status.enabled} disabled={busy} onChange={enabled=>{
        if(enabled){setError('');setCopy(false);setConfirm('enable')}else void run(()=>api.configure(false,false,status.accountScope))
      }}/></div>
      
      <div className="skill-toolbar">
        <button disabled={working||!status.enabled} onClick={()=>void run(()=>api.run())}>{status.phase==='syncing'?'正在同步…':'立即同步'}</button>
        {status.joined&&<button disabled={working} onClick={()=>{setError('');setConfirm('copy')}}>将本机词典复制到此账号</button>}
        {status.joined&&status.detail==='dictionary_cursor_ahead'&&<button disabled={working} onClick={()=>{setError('');setConfirm('rebuild')}}>重新对齐词库</button>}
        <small>{status.pending?`${status.pending} 项待处理，其中 ${status.conflicts} 项冲突`:status.lastSyncedAt?`上次同步 ${new Date(status.lastSyncedAt).toLocaleString()}`:'尚未同步'}</small>
      </div>
      {status.detail&&<p role="status" className="inline-error">{errorMessage(status.detail)}</p>}
      {conflicts.length>0&&<div className="dictionary-conflicts"><h3>需要选择的词条冲突</h3><p className="muted">这些词条在两台设备上都改过，选一份保留。</p>
        {conflicts.map(item=><div className="dictionary-conflict" key={item.key}><div><strong>{item.local.term??item.remote.term??item.previous?.term??'词条'}</strong><p>本机：{describe(item.local)}</p><p>云端：{describe(item.remote)}</p></div><button disabled={working} onClick={()=>{setError('');setSelected(item)}}>处理冲突</button></div>)}
        {status.conflicts>conflicts.length&&<p className="muted">当前显示前 {conflicts.length} 项，处理后继续显示其余冲突。</p>}
      </div>}
    </>:null}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {confirm&&<Modal title={confirm==='enable'?'开启词库同步':confirm==='rebuild'?'重新对齐词库':'复制本机词典'} onClose={()=>{if(!busy)setConfirm(undefined)}}><div className="dialog-body">
      <p>{confirm==='enable'?'此设备将自动同步当前账号的词条、释义和删除操作。首次开启后会使用此账号的本机词典副本。':confirm==='rebuild'?'服务端的词库版本早于本机记录，可能恢复过旧备份。重新对齐会保留本机当前词条及待同步删除，清除旧同步进度，再逐项比对云端词库。':'将当前本机词典复制到这个账号的词典。已存在的词条保留账号词典释义；本机词典原有内容保留。'}</p>
      {confirm==='enable'&&<label className="backup-choice"><input type="checkbox" checked={copy} disabled={busy} onChange={e=>setCopy(e.target.checked)}/>同时复制现有本机词典到此账号</label>}
      <p className="muted">{confirm==='rebuild'?'云端缺少的本机词条可能会重新上传；双方内容或删除状态不同时会列出冲突，等待你选择。此操作只影响当前账号。':'开启后，这个账号词典中的词条会发送至已配置的 OpenType 服务。不会自动复制其他账号的词典。'}</p>
      {error&&<p role="alert" className="inline-error">{error}</p>}
      <div className="dialog-actions"><button disabled={busy} onClick={()=>setConfirm(undefined)}>取消</button><button className="primary" disabled={busy} onClick={()=>void run(async()=>{
        if(confirm==='enable')await api.configure(true,copy,status.accountScope)
        else if(confirm==='rebuild'){await api.rebuild(status.accountScope);notify('已重新对齐，词条差异将在同步后显示')}
        else{const r=await api.copyLocal(status.accountScope);notify(`已复制 ${r.added} 条词条到此账号`)}
        setConfirm(undefined)
      })}>{confirm==='enable'?'开启同步':confirm==='rebuild'?'确认重新对齐':'确认复制'}</button></div>
    </div></Modal>}
    {selected&&<Modal title="处理词条冲突" onClose={()=>{if(!busy)setSelected(undefined)}}><div className="dialog-body">
      <p>本机：{describe(selected.local)}</p><p>云端：{describe(selected.remote)}</p>
      {error&&<p role="alert" className="inline-error">{error}</p>}
      <div className="dialog-actions"><button disabled={busy} onClick={()=>setSelected(undefined)}>稍后处理</button>
        <button disabled={working} onClick={()=>void run(async()=>{await api.resolve(selected.key,selected.remote.revision,'remote',status.accountScope,selected.mutationId);setSelected(undefined)})}>采用云端</button>
        <button className="primary" disabled={working} onClick={()=>void run(async()=>{await api.resolve(selected.key,selected.remote.revision,'local',status.accountScope,selected.mutationId);setSelected(undefined)})}>采用本机</button></div>
    </div></Modal>}
  </section>
}
