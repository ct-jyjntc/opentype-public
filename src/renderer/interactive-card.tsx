import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon, IconButton } from './components/ui'
import { Markdown } from './components/markdown'
import { errorMessage, type CardPayload } from '../shared/desktop'
import './app.css'
function Card() {
  const [payload, setPayload] = useState<CardPayload | null>(null)
  const [copied, setCopied] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [skill, setSkill] = useState(''), [instruction, setInstruction] = useState('')
  const currentId = useRef<string>()
  const cardRef = useRef<HTMLDivElement>(null)
  // Size the window to the content: short answers get a short card, long ones scroll inside.
  useEffect(() => {
    const card = cardRef.current
    if (!card || !window.opentype.desktop.card.resize) return
    const report = () => {
      const body = card.querySelector<HTMLElement>('.answer-text')
      const extra = body ? body.scrollHeight - body.clientHeight : 0
      void window.opentype.desktop.card.resize(Math.ceil(card.getBoundingClientRect().height + extra)).catch(() => {})
    }
    const observer = new ResizeObserver(report)
    observer.observe(card)
    card.querySelectorAll('.answer-text').forEach(el => observer.observe(el))
    const mutation = new MutationObserver(report)
    mutation.observe(card, { childList: true, subtree: true, characterData: true })
    report()
    return () => { observer.disconnect(); mutation.disconnect() }
  }, [])
  useEffect(() => {
    let updated = false, disposed = false
    const receive = (p: CardPayload | null) => {
      const changed = currentId.current !== p?.id
      currentId.current = p?.id; setPayload(p)
      if (changed) { setCopied(false); setBusy(false); setError(''); setSkill(''); setInstruction('') }
    }
    const off = window.opentype.desktop.card.onUpdate(p => { updated = true; receive(p) })
    void window.opentype.desktop.card.get().then(p => { if (!disposed && !updated) receive(p) })
    return () => { disposed = true; off() }
  }, [])
  const copy = async () => {
    const id = payload?.id
    try {
      await window.opentype.desktop.copy(payload?.text ?? '')
      if (currentId.current === id) { setCopied(true); setError('') }
    } catch (e) { if (currentId.current === id) setError(errorMessage(e)) }
  }
  const replace = async () => {
    const id = payload?.id
    if (!id || busy) return
    setBusy(true); setError('')
    try { await window.opentype.desktop.card.replaceSelection(id) }
    catch (e) { if (currentId.current === id) setError(errorMessage(e)) }
    finally { if (currentId.current === id) setBusy(false) }
  }
  const action = async (kind: 'summarize'|'rewrite'|'translate'|'proofread'|'skill'|'custom') => {
    if (!payload?.id || busy || payload.selectionActions?.busy) return
    const id = payload.id; setBusy(true); setError('')
    try { await window.opentype.desktop.selection.run(id, kind, { skillId: skill, instruction }) }
    catch (e) { if (currentId.current === id) setError(errorMessage(e)) }
    finally { if (currentId.current === id) setBusy(false) }
  }
  const working = busy || payload?.selectionActions?.busy
  return (
    <div className="answer-card" ref={cardRef}>
      <header>
        <strong>{payload?.title || '随便问'}</strong>
        <IconButton name="close" label="关闭回答" onClick={() => void window.opentype.desktop.card.close()} />
      </header>
      {payload?.selectionActions ? <div className="answer-text selection-palette">
        <details><summary>选中的原文{payload.targetAppName ? ` · ${payload.targetAppName}` : ''}</summary><p className="selection-original">{payload.selectionActions.source}</p></details>
        <div className="selection-action-buttons">{([['summarize','摘要','list'],['rewrite','改写','pen'],['translate','翻译','languages'],['proofread','校对','spellcheck']] as const).map(([id,label,icon])=><button disabled={working} key={id} onClick={()=>void action(id)}><Icon name={icon} size={16} />{label}</button>)}</div>
        {!!payload.selectionActions.skills.length && <div className="skill-toolbar"><select aria-label="选区处理 Skill" value={skill} disabled={working} onChange={e=>setSkill(e.target.value)}><option value="">选择 Skill</option>{payload.selectionActions.skills.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button disabled={working||!skill} onClick={()=>void action('skill')}>应用 Skill</button></div>}
        <label className="field">自定义要求<textarea rows={2} maxLength={8000} placeholder="例如：改成一封简短的中文邮件" value={instruction} disabled={working} onChange={e=>setInstruction(e.target.value)} /></label>
        <button disabled={working||!instruction.trim()} onClick={()=>void action('custom')}>按要求处理</button>
        {working&&<><p className="muted">正在生成 · 完成后可选择替换原文</p><button onClick={()=>void window.opentype.desktop.selection.cancel(payload.id!).catch(e=>setError(errorMessage(e)))}>取消处理</button><Markdown text={payload.selectionActions.preview??''}/></>}
      </div> : <div className="answer-text">{payload?.text ? <Markdown text={payload.text} /> : '等待回答…'}</div>}
      {(error || payload?.detail) && <p className="answer-status" role="status">{error || errorMessage(payload?.detail)}</p>}
      {(payload?.contextNotice || payload?.canReplaceSelection) && <p className="answer-status muted">
        {payload?.canReplaceSelection
          ? [payload.contextNotice?.replace(/[。.]\s*$/, ''), `可替换${payload.targetAppName ? ` ${payload.targetAppName} 中` : ''}最初选中的文字`].filter(Boolean).join('，') + '。'
          : payload?.contextNotice}
      </p>}
      {!payload?.selectionActions && <footer>
        <button onClick={() => void copy()} disabled={!payload?.text}>{copied ? '已复制' : '复制文字'}</button>
        {(payload?.canReplaceSelection || payload?.applyingSelection) && <button className="primary" disabled={busy || payload?.applyingSelection} onClick={() => void replace()}>
          {busy || payload?.applyingSelection ? '正在替换…' : '替换选中文字'}
        </button>}
      </footer>}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Card />)
