import { useEffect, useRef, useState } from 'react'
import { errorMessage, type Preferences } from '../../shared/desktop'
import { defaultSkills, readSkillSettings, SKILL_MODES, type SkillSettings, type WritingSkill } from '../../shared/skills'
import type { WritingApp } from '../../shared/output-preferences'
import { Icon, Menu, Modal, Row, Toggle } from '../components/ui'
import { Markdown } from '../components/markdown'

const api = window.opentype.desktop
const copySkill = (skill: WritingSkill): WritingSkill => ({ ...skill, modes: [...skill.modes], apps: [...skill.apps], domains: [...skill.domains] })
export function SkillsPage({ preferences, save }: { preferences: Preferences; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  const settings = preferences.skills
  const [editing, setEditing] = useState<WritingSkill>(), [deleting, setDeleting] = useState<WritingSkill>()
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [imported, setImported] = useState<WritingSkill[]>(), [apps, setApps] = useState<WritingApp[]>([])
  const upload = useRef<HTMLInputElement>(null)
  useEffect(() => { void api.writingApps().then(setApps).catch(()=>{}) }, [])
  const persist = async (next: SkillSettings) => {
    setBusy(true); setError('')
    try { return await save({ skills: readSkillSettings(next, true) }) }
    catch (e) { setError(errorMessage(e)); return false }
    finally { setBusy(false) }
  }
  const replace = (items: WritingSkill[]) => persist({ ...settings, items,
    selected: ['auto','none'].includes(settings.selected) || items.some(s=>s.id===settings.selected && s.enabled) ? settings.selected : 'auto' })
  const shift = (id: string, by: number) => {
    const next = [...settings.items], at = next.findIndex(s=>s.id===id), to = at + by
    if (to < 0 || to >= next.length) return
    ;[next[at], next[to]] = [next[to], next[at]]
    void replace(next)
  }
  const exportSkills = () => {
    const blob = new Blob([JSON.stringify({ format: 'opentype-skills', version: 1, items: settings.items }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = 'OpenType-Skills.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 1000)
  }
  const create = () => setEditing({id:crypto.randomUUID(),name:'',description:'',instructions:'',enabled:true,automatic:false,modes:['voice_transcript'],apps:[],domains:[]})
  const visible = settings.items.filter(s=>(s.name+' '+s.description).toLowerCase().includes(query.toLowerCase()))
  return <>
    <div className="page-heading">
      <h1>Skills</h1>
      <button className="primary" disabled={busy || settings.items.length >= 100} onClick={create}><Icon name="plus" size={16} />新建 Skill</button>
    </div>
    <p className="page-lede">给不同场景定好整理方式，比如邮件、聊天、会议纪要。需要开启文字整理。</p>
    <section className="settings-group">
      <Row title="启用 Skills" description="关闭后恢复普通听写、翻译和随便问。"><Toggle label="启用 Skills" checked={settings.enabled} disabled={busy} onChange={enabled=>void persist({...settings,enabled})} /></Row>
      <Row title="当前处理方式">
        <select aria-label="当前 Skill" value={settings.selected} disabled={busy || !settings.enabled} onChange={e=>void persist({...settings,selected:e.target.value})}>
          <option value="auto">按场景自动选择</option><option value="none">不使用 Skill</option>
          {settings.items.filter(s=>s.enabled).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Row>
    </section>
    <div className="list-toolbar">
      <h2 className="list-title">全部 Skills <span className="count">{settings.items.length}</span></h2>
      <div className="inline">
        <button disabled={busy} onClick={()=>upload.current?.click()}><Icon name="download" size={15} />导入</button>
        <button onClick={exportSkills}><Icon name="upload" size={15} />导出</button>
        <button disabled={busy} onClick={()=>void replace([...settings.items,...defaultSkills().filter(t=>!settings.items.some(s=>s.id===t.id))])}><Icon name="refresh" size={15} />补充内置模板</button>
        <label className="search"><Icon name="search" size={15} /><input aria-label="搜索 Skills" placeholder="搜索" value={query} onChange={e=>setQuery(e.target.value)} /></label>
      </div>
      <input ref={upload} type="file" accept="application/json,.json" hidden onChange={async e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return
        try {
          if(file.size>2*1024*1024)throw new Error('文件不能超过 2 MB')
          const data=JSON.parse(await file.text())
          if(data.format!=='opentype-skills'||data.version!==1)throw new Error('无法识别这个文件')
          const parsed=readSkillSettings({enabled:true,selected:'auto',items:data.items},true)
          if(parsed.items.length+settings.items.length>100)throw new Error('Skills 最多 100 个 Skill')
          setImported(parsed.items)
        } catch(e){setError(errorMessage(e))}
      }} />
    </div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="skill-list">
      {visible.map(skill=>{
        const first=settings.items[0].id===skill.id, last=settings.items.at(-1)?.id===skill.id
        return <article className={`skill-entry ${skill.enabled?'':'off'}`} key={skill.id}>
          <div className="skill-entry-main">
            <strong>{skill.name}</strong>
            <p>{skill.description || '自定义文字处理'}</p>
            <small>{skill.modes.map(m=>SKILL_MODES.find(([key])=>key===m)?.[1]).join('、')}<span>{skill.automatic?'自动匹配':'手动选用'}</span>
              {skill.automatic && <span>{skill.apps.map(id=>apps.find(a=>a.bundleId===id)?.appName??id).join('、')||'所有应用'}{skill.domains.length?' / '+skill.domains.join('、'):''}</span>}</small>
          </div>
          <div className="skill-entry-actions">
            <Toggle label={`启用 ${skill.name}`} checked={skill.enabled} disabled={busy} onChange={enabled=>void replace(settings.items.map(s=>s.id===skill.id?{...s,enabled}:s))} />
            <button disabled={busy} onClick={()=>setEditing(copySkill(skill))}>编辑</button>
            <Menu label={`${skill.name} 的更多操作`} items={[
              { label: '复制', disabled: busy || settings.items.length>=100, onSelect: ()=>setEditing({...copySkill(skill),id:crypto.randomUUID(),name:skill.name+' 副本',automatic:false}) },
              { label: '上移', aria: `上移 ${skill.name}`, disabled: busy||first, onSelect: ()=>shift(skill.id,-1) },
              { label: '下移', aria: `下移 ${skill.name}`, disabled: busy||last, onSelect: ()=>shift(skill.id,1) },
              { label: '删除', danger: true, disabled: busy, onSelect: ()=>setDeleting(skill) },
            ]} />
          </div>
        </article>})}
      {!settings.items.length && <p className="empty-state">创建一个 Skill，或补充内置模板。</p>}
      {!!settings.items.length && !visible.length && <p className="empty-state">没有符合“{query}”的 Skill。</p>}
    </div>
    <SkillWorkbench settings={settings} />
    {editing && <SkillEditor key={editing.id} skill={editing} apps={apps} close={()=>setEditing(undefined)} save={async value=>{
      const items=settings.items.some(s=>s.id===value.id)?settings.items.map(s=>s.id===value.id?value:s):[...settings.items,value]
      if(await replace(items)){setEditing(undefined);return true}return false
    }} />}
    {deleting && <Modal title="删除 Skill" onClose={()=>{if(!busy)setDeleting(undefined)}}><div className="dialog-body">
      <p>删除“{deleting.name}”？历史文字保留，重新识别时不再使用这个 Skill。</p>
      <div className="dialog-actions"><button disabled={busy} onClick={()=>setDeleting(undefined)}>取消</button><button className="danger" disabled={busy} onClick={async()=>{if(await replace(settings.items.filter(s=>s.id!==deleting.id)))setDeleting(undefined)}}>删除 Skill</button></div>
    </div></Modal>}
    {imported && <Modal title="导入 Skills" onClose={()=>{if(!busy)setImported(undefined)}}><div className="dialog-body">
      <p>将新增 {imported.length} 个 Skill，自动应用默认关闭。</p>
      <p>{imported.map(s=>s.name).join('、')}</p>
      <div className="dialog-actions"><button disabled={busy} onClick={()=>setImported(undefined)}>取消</button><button className="primary" disabled={busy||!imported.length} onClick={async()=>{
        if(await replace([...settings.items,...imported.map(s=>({...s,id:crypto.randomUUID(),automatic:false}))]))setImported(undefined)
      }}>确认导入</button></div>
    </div></Modal>}
  </>
}
function SkillEditor({ skill, apps, close, save }: { skill: WritingSkill; apps: WritingApp[]; close:()=>void; save:(skill:WritingSkill)=>Promise<boolean> }) {
  const [draft,setDraft]=useState(copySkill(skill)),[domains,setDomains]=useState(skill.domains.join('\n')),[customApp,setCustomApp]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const patch=(p:Partial<WritingSkill>)=>setDraft(v=>({...v,...p}))
  return <Modal title={skill.name?'编辑 Skill':'新建 Skill'} onClose={()=>{if(!busy)close()}} wide><form className="dialog-body skill-editor" onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError('')
    try {
      const value={...draft,domains:domains.split(/[\s,，]+/).map(d=>d.trim().toLowerCase()).filter(Boolean)}
      readSkillSettings({enabled:true,selected:'auto',items:[value]},true)
      await save(value)
    } catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }}>
    <label className="field">名称<input required maxLength={60} value={draft.name} onChange={e=>patch({name:e.target.value})} /></label>
    <label className="field">说明<input maxLength={320} value={draft.description} onChange={e=>patch({description:e.target.value})} /></label>
    <label className="field">处理指令<textarea required rows={7} maxLength={8000} value={draft.instructions} onChange={e=>patch({instructions:e.target.value})} placeholder="比如：整理成要点，保留人名和数字" /></label>
    <fieldset className="skill-modes"><legend>适用模式</legend>{SKILL_MODES.map(([mode,label])=><label key={mode}><input type="checkbox" checked={draft.modes.includes(mode)} disabled={draft.modes.length===1&&draft.modes.includes(mode)} onChange={e=>patch({modes:e.target.checked?[...draft.modes,mode]:draft.modes.filter(m=>m!==mode)})}/>{label}</label>)}</fieldset>
    <Row title="按场景自动应用"><Toggle label="按场景自动应用" checked={draft.automatic} onChange={automatic=>patch({automatic})}/></Row>
    {draft.automatic && <div className="skill-scope">
    <label className="field">限定应用<select value="" onChange={e=>{if(e.target.value&&!draft.apps.includes(e.target.value))patch({apps:[...draft.apps,e.target.value]})}}><option value="">选择应用；留空匹配所有应用</option>{apps.map(a=><option value={a.bundleId} key={a.bundleId}>{a.appName}</option>)}</select></label>
    <div className="skill-apps">{draft.apps.map(id=><button type="button" key={id} onClick={()=>patch({apps:draft.apps.filter(a=>a!==id)})}>{apps.find(a=>a.bundleId===id)?.appName??id} ×</button>)}</div>
    <div className="skill-toolbar"><input aria-label="自定义应用标识" placeholder="应用标识，如 com.apple.mail" value={customApp} onChange={e=>setCustomApp(e.target.value)}/><button type="button" onClick={()=>{const id=customApp.trim();if(id&&!draft.apps.includes(id))patch({apps:[...draft.apps,id]});setCustomApp('')}}>添加应用</button></div>
    <label className="field">限定网站域名<textarea rows={2} value={domains} onChange={e=>setDomains(e.target.value)} placeholder="每行一个域名，例如 mail.google.com；不要填写网址路径。"/></label>
    <p className="muted">都留空表示所有应用。</p>
    </div>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy}>{busy?'保存中…':'保存 Skill'}</button></div>
  </form></Modal>
}
function SkillWorkbench({ settings }: { settings: SkillSettings }) {
  const [preview,setPreview]=useState(''),[view,setView]=useState<'read'|'edit'>('read')
  const [selected,setSelected]=useState(''),[source,setSource]=useState(''),[result,setResult]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [resultFor,setResultFor]=useState<{source:string;skillId:string}>()
  const current=useRef<string>()
  const available=settings.items.filter(s=>s.enabled),skillId=available.some(s=>s.id===selected)?selected:available[0]?.id??''
  useEffect(()=>()=>{if(current.current)void api.skills.cancel(current.current).catch(()=>{})},[])
  useEffect(()=>api.skills.onProgress(value=>{if(current.current===value.id)setPreview(value.preview??'')}),[])
  const run=async()=>{
    const id=crypto.randomUUID();current.current=id;setBusy(true);setError('');setPreview('')
    try {const response=await api.skills.run(id,skillId,source);if(current.current===id){setResult(response.text);setResultFor({source,skillId})}}
    catch(e){if(current.current===id)setError(errorMessage(e))}
    finally{if(current.current===id){current.current=undefined;setBusy(false);setPreview('')}}
  }
  return <section className="skill-workbench"><h2>文字工作台</h2><p className="muted">粘贴一段文字试试效果。</p>
    <div className="skill-toolbar"><select aria-label="文字工作台 Skill" value={skillId} disabled={busy} onChange={e=>setSelected(e.target.value)}>{available.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <button className="primary" disabled={busy||!settings.enabled||!skillId||!source.trim()} onClick={()=>void run()}>{busy?'正在处理…':'处理文字'}</button>
      {busy&&<button onClick={()=>{const id=current.current;current.current=undefined;setBusy(false);setPreview('');setError('已取消');if(id)void api.skills.cancel(id).catch(()=>{})}}>取消</button>}
      <button disabled={!result} onClick={()=>void api.copy(result).catch(e=>setError(errorMessage(e)))}>复制结果</button></div>
    <div className="skill-text-columns"><label className="field">原文<textarea rows={8} value={source} onChange={e=>setSource(e.target.value)} disabled={busy}/></label><div className="field">
      <div className="skill-toolbar"><span>{busy?'正在生成 · 预览尚未完成':result && (resultFor?.source!==source || resultFor?.skillId!==skillId)?'上一次处理结果':'处理结果'}</span>
        <button disabled={busy} onClick={()=>setView(view==='read'?'edit':'read')}>{view==='read'?'编辑原文':'阅读视图'}</button></div>
      {busy || view==='read' ? <div className="skill-result" aria-busy={busy}><Markdown text={busy?preview||'等待回复…':result}/></div> : <textarea aria-label="编辑处理结果" rows={8} value={result} onChange={e=>setResult(e.target.value)}/>}
    </div></div>
    {error&&<p role="status" className="inline-error">{error}</p>}
  </section>
}
