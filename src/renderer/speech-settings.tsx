import { useEffect, useRef, useState } from 'react'
import type { ModelStatus } from '../main/services/local-asr/model-store'
import { errorMessage } from '../shared/desktop'
import { Icon, Toggle } from './components/ui'

type SpeechProvider = 'siliconflow' | 'local' | 'openai' | 'custom'
type SpeechConfig = { provider: SpeechProvider; enableRefine: boolean; hasRefineApiKey: boolean; hasSiliconflowApiKey: boolean }

export function SpeechSettings({ embedded = false, onDone, onBack }: { embedded?: boolean; onDone?: () => void; onBack?: () => void }) {
  const onboarding = !!onDone
  const [provider, setProvider] = useState<SpeechProvider>('siliconflow')
  const [savedProvider, setSavedProvider] = useState<SpeechProvider>('siliconflow')
  const [enabled, setEnabled] = useState(true)
  const [savedEnabled, setSavedEnabled] = useState(true)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [cloudKey, setCloudKey] = useState('')
  const [hasCloudKey, setHasCloudKey] = useState(false)
  const [clearCloudKey, setClearCloudKey] = useState(false)
  const [status, setStatus] = useState<ModelStatus>()
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [conflict, setConflict] = useState(false)
  const dirtyRef = useRef(false)
  const dirty = provider !== savedProvider || enabled !== savedEnabled || !!key.trim() || !!cloudKey.trim() || clearKey || clearCloudKey
  dirtyRef.current = dirty
  const effectiveCloudKey = !!cloudKey.trim() || (hasCloudKey && !clearCloudKey)
  const effectiveRefineKey = !!key.trim() || (hasKey && !clearKey)
  const applySaved = (config: SpeechConfig) => {
    setProvider(config.provider)
    setSavedProvider(config.provider)
    setEnabled(config.enableRefine)
    setSavedEnabled(config.enableRefine)
    setHasKey(config.hasRefineApiKey)
    setHasCloudKey(config.hasSiliconflowApiKey)
    setKey('')
    setCloudKey('')
    setClearKey(false)
    setClearCloudKey(false)
    setConflict(false)
    setLoaded(true)
  }
  useEffect(() => {
    let active = true, received = false
    const off = window.opentype.config.onChanged(config => {
      received = true
      if (!active || savingRef.current) return
      if (dirtyRef.current) setConflict(true)
      else applySaved(config)
    })
    void window.opentype.config.get().then((config) => {
      if (active && !received) applySaved(config)
    }).catch(() => {
      if (active) { setFailed(true); setMessage('无法读取设置，请重新打开此窗口。') }
    })
    return () => { active = false; off() }
  }, [])
  const reload = async () => {
    setLoaded(false)
    try { applySaved(await window.opentype.config.get()); setFailed(false); setMessage('已重新载入保存的设置。') }
    catch { setFailed(true); setMessage('无法读取设置，请重新打开此窗口。') }
  }
  useEffect(() => {
    if (!loaded || provider !== 'local') return
    let active = true
    const refresh = () => void window.opentype.localAsr.status()
      .then(value => { if (active) setStatus(value) })
      .catch(() => { if (active) { setFailed(true); setMessage('无法读取模型状态，请重新打开设置。') } })
    refresh()
    const interval = setInterval(refresh, 1000)
    return () => { active = false; clearInterval(interval) }
  }, [loaded, provider])
  const changed = () => { setMessage(''); setFailed(false) }
  const download = async () => {
    changed()
    setPreparing(true)
    setStatus(previous => ({ state: 'checking', downloaded: 0, total: previous?.total ?? 239549735 }))
    try { setStatus(await window.opentype.localAsr.install()) }
    catch { setFailed(true); setMessage('模型准备未完成，请先结束听写后重试。') }
    finally { setPreparing(false) }
  }
  const save = async (): Promise<boolean> => {
    if (!loaded || conflict || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    changed()
    try {
      const result = await window.opentype.config.set({
        ...(provider !== savedProvider ? { provider } : {}),
        ...(enabled !== savedEnabled ? { enableRefine: enabled } : {}),
        ...(cloudKey.trim() ? { siliconflowApiKey: cloudKey.trim() } : clearCloudKey ? { siliconflowApiKey: '' } : {}),
        ...(key.trim() ? { refineApiKey: key.trim() } : clearKey ? { refineApiKey: '' } : {}),
      })
      applySaved(result)
      setMessage('已保存')
      return true
    } catch (error) {
      setFailed(true)
      setMessage(`修改尚未生效：${errorMessage(error)}`)
    } finally { savingRef.current = false; setSaving(false) }
    return false
  }
  const next = async () => { if (!dirty || await save()) onDone?.() }
  const busyModel = status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking'
  return (
    <main className={`speech-settings ${embedded ? 'embedded' : ''} ${onboarding ? 'onboarding' : ''}`}>
      {!onboarding && <h1>听写模型</h1>}
      {conflict && <div className="speech-conflict" role="alert">
        <p>设置在别的窗口改过了。</p>
        <button disabled={saving || !loaded} onClick={() => void reload()}>重新载入</button>
      </div>}
      <fieldset disabled={!loaded || saving || conflict}>
        <section>
          <h2>语音识别</h2>
          <div role="radiogroup" aria-label="语音识别方式" className="choices">
            <label className={`choice ${provider === 'siliconflow' ? 'selected' : ''}`}>
              <input type="radio" name="speech-provider" value="siliconflow" checked={provider === 'siliconflow'} onChange={() => { changed(); setProvider('siliconflow') }} />
              <span><strong>云端</strong><small>不用下载，录音会上传</small></span>
            </label>
            <label className={`choice ${provider === 'local' ? 'selected' : ''}`}>
              <input type="radio" name="speech-provider" value="local" checked={provider === 'local'} onChange={() => { changed(); setProvider('local') }} />
              <span><strong>本地</strong><small>约 240 MB，可离线</small></span>
            </label>
          </div>
          {provider !== 'local' && provider !== 'siliconflow' && <p className="note">正在使用旧的语音服务，选一种后保存即可切换。</p>}
          {provider === 'siliconflow' && <>
            <label className="key-label">
              <span className="key-head">SiliconFlow API Key{hasCloudKey && <small>{clearCloudKey ? '保存后清除' : '已保存'}</small>}</span>
              <input type="password" autoComplete="off" spellCheck={false} value={cloudKey}
                onChange={event => { changed(); setCloudKey(event.target.value); setClearCloudKey(false) }} placeholder={hasCloudKey ? '留空则不变' : 'sk-…'} />
            </label>
            {hasCloudKey && <button type="button" className="key-action" onClick={() => { changed(); setCloudKey(''); setClearCloudKey(!clearCloudKey) }}>{clearCloudKey ? '撤销' : '清除 Key'}</button>}
            {!effectiveCloudKey && <p className="speech-warning">填上 Key 才能使用云端识别。</p>}
          </>}
          {provider === 'local' && <div className={`model-status ${status?.state === 'ready' ? 'ready' : status?.error ? 'error' : busyModel ? 'busy' : 'pending'}`} aria-live="polite">
            {status?.state === 'ready' ? <><Icon name="check" size={15} />模型已就绪</>
              : status?.state === 'downloading' || status?.state === 'installing' ? <>
                <progress value={status.downloaded} max={status.total} /> {Math.floor((status.downloaded / status.total) * 100)}%
                <button onClick={() => { void window.opentype.localAsr.cancel().catch(() => { setFailed(true); setMessage('取消失败，请重试。') }) }}>取消</button>
              </> : <>
                <span>{status?.error ?? (status?.state === 'checking' ? '正在检查…' : '模型还没下载')}</span>
                <button disabled={preparing || !status || status.state === 'checking'} onClick={() => void download()}>{status?.error ? '修复' : '下载模型'}</button>
              </>}
          </div>}
        </section>
        <section>
          <div className="section-title">
            <h2>文字整理</h2>
            <Toggle label="文字整理" checked={enabled} onChange={value => { changed(); setEnabled(value) }} />
          </div>
          <p>去掉口头禅、理顺标点，翻译和随便问也靠它。</p>
          {enabled && <>
            <label className="key-label">
              <span className="key-head">DeepSeek API Key{hasKey && <small>{clearKey ? '保存后清除' : '已保存'}</small>}</span>
              <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => { changed(); setKey(event.target.value); setClearKey(false) }} placeholder={hasKey ? '留空则不变' : 'sk-…'} />
            </label>
            {hasKey && <button type="button" className="key-action" onClick={() => { changed(); setKey(''); setClearKey(!clearKey) }}>{clearKey ? '撤销' : '清除 Key'}</button>}
            {!effectiveRefineKey && <p className="speech-warning">没有 Key 时直接输出识别原文。</p>}
          </>}
        </section>
      </fieldset>
      <footer>
        {onboarding ? <>
          <button className="primary large" disabled={!loaded || saving || conflict} onClick={() => void next()}>{saving ? '正在保存…' : '继续'} <Icon name="arrow" /></button>
          {onBack && <button className="ghost" onClick={onBack}>上一步</button>}
          <span role={failed ? 'alert' : 'status'} className={failed ? 'speech-warning' : 'muted'}>{failed ? message : ''}</span>
        </> : <>
          <span role={failed ? 'alert' : 'status'} className={failed ? 'speech-warning' : ''}>{message || (dirty ? '有未保存的修改' : '')}</span>
          <button className="primary" disabled={!loaded || saving || conflict || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>
        </>}
      </footer>
    </main>
  )
}
