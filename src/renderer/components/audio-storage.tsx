import { useEffect, useRef, useState } from 'react'
import { Modal } from './ui'
import { errorMessage } from '../../shared/desktop'
import type { AudioStorageAction, AudioStorageSnapshot, StoredAudio } from '../../shared/audio-storage'
const api = window.opentype.desktop.audioStorage
const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
export function AudioStorageDialog({ onClose, notify }: { onClose: () => void; notify: (s: string) => void }) {
  const [snapshot, setSnapshot] = useState<AudioStorageSnapshot | null>(null)
  const [tab, setTab] = useState<'candidates' | 'recycled'>('candidates')
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [confirm, setConfirm] = useState<AudioStorageAction | null>(null), [result, setResult] = useState('')
  const [audio, setAudio] = useState(''), [playing, setPlaying] = useState('')
  const url = useRef(''), generation = useRef(0)
  const stop = () => { generation.current++; if (url.current) URL.revokeObjectURL(url.current); url.current = ''; setAudio(''); setPlaying('') }
  const scan = async () => {
    stop(); setBusy(true); setSelected([]); setError('')
    try { setSnapshot(await api.scan()) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  useEffect(() => {
    void scan()
    return () => { generation.current++; if (url.current) URL.revokeObjectURL(url.current) }
  }, [])
  const items = snapshot?.[tab] ?? [], chosen = items.filter(f => selected.includes(f.key)), size = chosen.reduce((n,f) => n + f.bytes, 0)
  const preview = async (file: StoredAudio) => {
    if (!snapshot) return
    stop(); const gen = generation.current; setError(''); setBusy(true)
    try {
      const data = new Uint8Array(await api.preview(snapshot.token,file.key))
      if (gen !== generation.current) return
      url.current = URL.createObjectURL(new Blob([data],{type:file.name.endsWith('.ogg')?'audio/ogg':file.name.endsWith('.webm')?'audio/webm':'audio/wav'}))
      setAudio(url.current);setPlaying(file.name)
    } catch(e) { if(gen===generation.current)setError(errorMessage(e)) } finally { if(gen===generation.current)setBusy(false) }
  }
  const act = async (action: AudioStorageAction) => {
    if (!snapshot) return
    stop();setBusy(true);setError('');setConfirm(null)
    try {
      const r = await api.act(snapshot.token,selected,action)
      const summary = action === 'recycle' ? `已将 ${r.completed} 个文件移入回收站，${bytes(r.bytes)}。`
        : action === 'erase' ? `已永久删除 ${r.completed} 个文件，文件总大小 ${bytes(r.bytes)}。`
        : action === 'restore' ? `已将 ${r.completed} 个文件还原。`
        : `已将 ${r.completed} 份录音找回到历史。`
      setResult(summary);notify(summary)
      await scan()
      if (r.failed.length) setError(r.failed.map(f=>`${f.name}：${errorMessage(f.detail)}`).join('\n'))
    } catch(e) {setError(errorMessage(e))} finally {setBusy(false)}
  }
  return <><Modal title="录音存储管理" onClose={() => { if (!busy) onClose() }}>
    <div className="dialog-body audio-storage">
      <p>这些录音没有对应的历史记录，可以找回或清理。移入回收站不会释放空间，永久删除后才会释放。</p>
      
      <div className="list-toolbar"><div className="tabs">
        <button disabled={busy} className={tab==='candidates'?'active':''} onClick={()=>{stop();setTab('candidates');setSelected([]);setConfirm(null)}}>待核对录音（{snapshot?.candidates.length ?? 0}）</button>
        <button disabled={busy} className={tab==='recycled'?'active':''} onClick={()=>{stop();setTab('recycled');setSelected([]);setConfirm(null)}}>录音回收站（{snapshot?.recycled.length ?? 0}）</button>
      </div><button disabled={busy} onClick={()=>void scan()}>重新扫描</button></div>
      
      {snapshot?.truncated && <p className="warning">只显示前 200 个，处理后重新扫描查看其余。</p>}
      {!!snapshot?.unresolvedItems && <p className="warning">{snapshot.unresolvedItems} 项操作没有完成，文件已保留。</p>}
      {!snapshot && busy ? <p>正在扫描…</p> : items.length === 0 ? <p>{tab==='candidates'?'没有可清理的旧孤立录音。':'录音回收站为空。'}</p> : <>
        <label className="storage-select"><input type="checkbox" aria-label="选择当前列表" disabled={busy} checked={items.length>0 && selected.length===items.length} onChange={e=>setSelected(e.target.checked?items.map(f=>f.key):[])} />选择当前列表</label>
        <div className="storage-files">{items.map(file=><div className="storage-file" key={file.key}>
          <label><input type="checkbox" aria-label={`选择 ${file.name}`} checked={selected.includes(file.key)} disabled={busy} onChange={e=>setSelected(old=>e.target.checked?[...old,file.key]:old.filter(k=>k!==file.key))} /><span><strong>{file.name}</strong><small>{bytes(file.bytes)} · {new Date(file.modifiedAt).toLocaleString('zh-CN')}</small></span></label>
          <button disabled={busy} onClick={()=>void preview(file)} aria-label={`试听 ${file.name}`}>试听</button>
        </div>)}</div>
      </>}
      {audio && <div className="storage-player"><span>{playing}</span><audio controls src={audio} aria-label="试听待核对录音" /></div>}
      <p className="storage-summary">已选 {chosen.length} 个，共 {bytes(size)}</p>
      <div className="dialog-actions">
        <button disabled={busy||!chosen.length} onClick={()=>void act('recover')}>找回到历史</button>
        {tab==='recycled' && <button disabled={busy||!chosen.length} onClick={()=>void act('restore')}>仅还原文件</button>}
        <button className="danger" disabled={busy||!chosen.length} onClick={()=>setConfirm(tab==='candidates'?'recycle':'erase')}>{tab==='candidates'?'移入录音回收站':'永久删除所选'}</button>
      </div>
      {result && <p role="status">{result}</p>}
      {error && <p className="inline-error storage-errors" role="alert">{error}</p>}
    </div>
  </Modal>
    {confirm && <Modal title={confirm==='erase'?'永久删除录音':'移入录音回收站'} onClose={()=>{if(!busy)setConfirm(null)}}>
      <div className="dialog-body">
        <p>{confirm==='erase'?`永久删除所选 ${chosen.length} 个录音文件（${bytes(size)}）？这些回收站文件将无法恢复。`:`将所选 ${chosen.length} 个文件移入录音回收站？之后仍可找回到历史。`}</p>
        <div className="dialog-actions"><button disabled={busy} onClick={()=>setConfirm(null)}>取消</button><button className="danger" disabled={busy||!chosen.length} onClick={()=>void act(confirm)}>{confirm==='erase'?'确认永久删除':'确认移入回收站'}</button></div>
      </div>
    </Modal>}
  </>
}
