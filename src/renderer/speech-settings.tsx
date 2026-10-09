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
  const preparingRef = useRef(false), cancelledRef = useRef(false), mountedRef = useRef(true)
  const [conflict, setConflict] = useState(false)
  const conflictRef = useRef(false)
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
    conflictRef.current = false
    setLoaded(true)
  }
  useEffect(() => {
    mountedRef.current = true
    let active = true, received = false
    const off = window.opentype.config.onChanged(config => {
      received = true
      if (!active || savingRef.current) return
      if (dirtyRef.current || preparingRef.current) { conflictRef.current = true; setConflict(true) }
      else applySaved(config)
    })
    void window.opentype.config.get().then((config) => {
      if (active && !received) applySaved(config)
    }).catch(() => {
      if (active) { setFailed(true); setMessage('无法读取设置，请重新打开此窗口。') }
    })
    return () => { active = false; mountedRef.current = false; cancelledRef.current = true; off() }
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
  const saveError = (error: unknown) => {
    if (String(error).includes('speech_settings_changed')) {
      conflictRef.current = true; setConflict(true)
      return '设置已在其他窗口更改，请重新载入。'
    }
    return errorMessage(error)
  }
  const download = async () => {
    if (!loaded || savingRef.current || preparingRef.current || conflictRef.current) return
    changed()
    preparingRef.current = true; cancelledRef.current = false
    setPreparing(true)
    setStatus(previous => ({ state: 'checking', downloaded: 0, total: previous?.total ?? 239549735 }))
    try {
      const result = await window.opentype.localAsr.install()
      if (!mountedRef.current) return
      setStatus(result)
      if (cancelledRef.current) { setMessage('已取消，识别方式未更改。'); return }
      if (result.state !== 'ready') throw new Error(result.error || '模型尚未准备完成，请重试。')
      if (conflictRef.current) { setMessage('模型已准备好。请重新载入设置后再启用。'); return }
      savingRef.current = true; setSaving(true)
      const saved = await window.opentype.config.set({ provider: 'local' })
      if (!mountedRef.current) return
      // Enabling the model must not discard unrelated text/key drafts.
      setProvider(saved.provider); setSavedProvider(saved.provider)
      const otherChanges = enabled !== savedEnabled || !!key.trim() || !!cloudKey.trim() || clearKey || clearCloudKey
      setMessage(otherChanges ? '本地模型已启用，其他修改仍需保存。' : '本地模型已启用。')
    } catch (error) {
      if (mountedRef.current) { setFailed(true); setMessage(saveError(error)) }
    } finally {
      preparingRef.current = false; savingRef.current = false
      if (mountedRef.current) { setPreparing(false); setSaving(false) }
    }
  }
  const cancelDownload = async () => {
    cancelledRef.current = true
    setMessage('正在取消…')
    try { await window.opentype.localAsr.cancel() }
    catch (error) { setFailed(true); setMessage(errorMessage(error)) }
  }
  const save = async (): Promise<boolean> => {
    if (!loaded || conflict || savingRef.current || preparingRef.current) return false
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
      setMessage(`修改尚未生效：${saveError(error)}`)
    } finally { savingRef.current = false; setSaving(false) }
    return false
  }
  const next = async () => {
    if (!loaded || conflict || savingRef.current || preparingRef.current) return
    if (provider === 'siliconflow' && !effectiveCloudKey) {
      setFailed(true); setMessage('请填写云端 Key，或切换到本地并准备模型。'); return
    }
    if (provider === 'local' && status?.state !== 'ready') {
      setFailed(true); setMessage('请先准备本地模型，再继续。'); return
    }
    if (!dirty || await save()) onDone?.()
  }
  const busyModel = status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking'
  return (
    <main className={`speech-settings ${embedded ? 'embedded' : ''} ${onboarding ? 'onboarding' : ''}`}>
      {!onboarding && <h1>听写模型</h1>}
      {conflict && <div className="speech-conflict" role="alert">
        <p>设置在别的窗口改过了。</p>
        <button disabled={saving || preparing} onClick={() => void reload()}>放弃修改并重新载入</button>
      </div>}
      {!loaded && failed && !conflict && <button onClick={() => void reload()}>重新读取设置</button>}
      <fieldset disabled={!loaded || saving || conflict}>
        <section>
          <h2>语音识别</h2>
          <div role="radiogroup" aria-label="语音识别方式" className="choices">
            <label className={`choice ${provider === 'siliconflow' ? 'selected' : ''}`}>
              <input type="radio" disabled={preparing} name="speech-provider" value="siliconflow" checked={provider === 'siliconflow'} onChange={() => { changed(); setProvider('siliconflow') }} />
              <span><strong>云端</strong><small>录音上传到 SiliconFlow</small></span>
            </label>
            <label className={`choice ${provider === 'local' ? 'selected' : ''}`}>
              <input type="radio" disabled={preparing} name="speech-provider" value="local" checked={provider === 'local'} onChange={() => { changed(); setProvider('local') }} />
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
            {status?.state === 'ready' ? <><Icon name="check" size={15} />{savedProvider === 'local' ? '本地模型已启用' : '模型已就绪'}
                {savedProvider !== 'local' && <button disabled={preparing} onClick={() => void download()}>启用本地模型</button>}</>
              : status?.state === 'downloading' || status?.state === 'installing' ? <>
                <progress value={status.downloaded} max={status.total} /> {Math.floor((status.downloaded / status.total) * 100)}%
                {!preparing && <button onClick={() => void cancelDownload()}>取消准备</button>}
              </> : <>
                <span>{status?.error ?? (status?.state === 'checking' ? '正在检查…' : '模型还没下载')}</span>
                <button disabled={preparing || !status || status.state === 'checking'} onClick={() => void download()}>{status?.error ? '重试并启用' : '下载并启用'}</button>
              </>}
          </div>}
        </section>
        <section>
          <div className="section-title">
            <h2>文字整理</h2>
            <Toggle label="文字整理" disabled={preparing} checked={enabled} onChange={value => { changed(); setEnabled(value) }} />
          </div>
          <p>去掉口头禅、理顺标点，翻译和随便问也靠它。开启后，识别文字与允许的文字上下文会发送到整理服务。</p>
          {enabled && <>
            <label className="key-label">
              <span className="key-head">DeepSeek API Key{hasKey && <small>{clearKey ? '保存后清除' : '已保存'}</small>}</span>
              <input type="password" disabled={preparing} autoComplete="off" spellCheck={false} value={key} onChange={event => { changed(); setKey(event.target.value); setClearKey(false) }} placeholder={hasKey ? '留空则不变' : 'sk-…'} />
            </label>
            {hasKey && <button type="button" disabled={preparing} className="key-action" onClick={() => { changed(); setKey(''); setClearKey(!clearKey) }}>{clearKey ? '撤销' : '清除 Key'}</button>}
            {!effectiveRefineKey && <p className="speech-warning">没有 Key 时直接输出识别原文。</p>}
          </>}
        </section>
      </fieldset>
      {preparing && <div className="model-status" role="status">
        <span>{saving ? '正在启用本地模型…' : status?.state === 'checking' ? '正在检查本地模型…' : '正在准备本地模型…'}</span>
        <button disabled={saving} onClick={() => void cancelDownload()}>取消准备</button>
      </div>}
      <footer>
        {onboarding ? <>
          <button className="primary large" disabled={!loaded || saving || preparing || conflict} onClick={() => void next()}>{saving ? '正在保存…' : '继续'} <Icon name="arrow" /></button>
          {onBack && <button className="ghost" disabled={saving || preparing} onClick={onBack}>上一步</button>}
          <span role={failed ? 'alert' : 'status'} className={failed ? 'speech-warning' : 'muted'}>{failed ? message : ''}</span>
        </> : <>
          <span role={failed ? 'alert' : 'status'} className={failed ? 'speech-warning' : ''}>{message || (dirty ? '有未保存的修改' : '')}</span>
          <button className="primary" disabled={!loaded || saving || preparing || conflict || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>
        </>}
      </footer>
    </main>
  )
}
