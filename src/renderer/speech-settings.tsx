import { useEffect, useRef, useState } from 'react'
import type { ModelStatus } from '../main/services/local-asr/model-store'
import { errorMessage } from '../shared/desktop'

type SpeechProvider = 'siliconflow' | 'local' | 'openai' | 'custom'
type SpeechConfig = { provider: SpeechProvider; enableRefine: boolean; hasRefineApiKey: boolean; hasSiliconflowApiKey: boolean }
const providerName = (provider: SpeechProvider) => provider === 'siliconflow'
  ? 'SiliconFlow 云端' : provider === 'local' ? 'SenseVoice 本地' : '原有语音服务'

export function SpeechSettings({ embedded = false }: { embedded?: boolean }) {
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
  const save = async () => {
    if (!loaded || conflict || savingRef.current) return
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
      setMessage('设置已保存，下一次听写生效。')
    } catch (error) {
      setFailed(true)
      setMessage(`修改尚未生效：${errorMessage(error)}`)
    } finally { savingRef.current = false; setSaving(false) }
  }
  return (
    <main className={`speech-settings ${embedded ? 'embedded' : ''}`}>
      <h1>听写模型</h1>
      <p className="intro">使用 SenseVoice Small，云端与本地任选。录音不设总时长上限。</p>
      <p className="saved-provider" aria-live="polite">
        {loaded ? `${conflict ? '上次读取' : '当前已保存'}：${providerName(savedProvider)}` : '正在读取设置…'}
        {dirty && ' · 有未保存的修改'}
      </p>
      {conflict && <div className="speech-conflict" role="alert">
        <p>设置已在另一窗口更改。为避免覆盖，请先放弃此处未保存的修改并重新载入。</p>
        <button disabled={saving || !loaded} onClick={() => void reload()}>放弃修改并重新载入</button>
      </div>}
      <fieldset disabled={!loaded || saving || conflict}>
        <section>
          <h2>语音识别方式</h2>
          <div role="radiogroup" aria-label="语音识别方式">
            <label className={`choice ${provider === 'siliconflow' ? 'selected' : ''}`}>
              <input type="radio" name="speech-provider" value="siliconflow" checked={provider === 'siliconflow'} onChange={() => { changed(); setProvider('siliconflow') }} />
              <span><strong>SiliconFlow 云端 <em>无需下载模型</em></strong>
                <small>使用 SenseVoice Small；录音会上传到 SiliconFlow，需要网络和您自己的 API Key。</small></span>
            </label>
            <label className={`choice ${provider === 'local' ? 'selected' : ''}`}>
              <input type="radio" name="speech-provider" value="local" checked={provider === 'local'} onChange={() => { changed(); setProvider('local') }} />
              <span><strong>SenseVoice Small 本地 <em>可离线</em></strong>
                <small>模型约 240 MB，语音识别在本机完成。支持普通话、粤语、英语、日语和韩语。</small></span>
            </label>
          </div>
          {provider !== 'local' && provider !== 'siliconflow' && <p className="note">当前继续使用原有语音服务。选择上方方式并保存后才会切换。</p>}
          {provider === 'siliconflow' && <>
            <label className="key-label">
              SiliconFlow API Key
              <span>{clearCloudKey ? '保存后清除现有密钥' : hasCloudKey ? '已安全保存；留空保留，输入新密钥可替换' : '密钥仅用于 SiliconFlow 语音识别'}</span>
              <input type="password" autoComplete="off" spellCheck={false} value={cloudKey}
                onChange={event => { changed(); setCloudKey(event.target.value); setClearCloudKey(false) }} placeholder="输入 SiliconFlow API Key" />
            </label>
            {hasCloudKey && <button type="button" className="key-action" onClick={() => { changed(); setCloudKey(''); setClearCloudKey(!clearCloudKey) }}>{clearCloudKey ? '撤销清除密钥' : '清除已保存的密钥'}</button>}
            <p className="note">云端识别使用 FunAudioLLM/SenseVoiceSmall。录音期间会按停顿分段上传，结束后补齐剩余内容；云端服务按其规则计费。不会自动切换到本地识别。</p>
            {!effectiveCloudKey && <p className="speech-warning">尚未配置云端密钥。请填写并保存，或选择本地识别后保存。</p>}
          </>}
          {provider === 'local' && <>
            <div className={`model-status ${status?.state === 'ready' ? 'ready' : status?.error ? 'error' : status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking' ? 'busy' : 'pending'}`} aria-live="polite">
              {status?.state === 'ready' ? '✓ SenseVoice 模型已就绪，文件校验通过'
                : status?.state === 'downloading' || status?.state === 'installing' ? <>
                  <progress value={status.downloaded} max={status.total} /> {status.state === 'installing' ? '正在从安装包准备模型' : '正在下载模型'} {Math.floor((status.downloaded / status.total) * 100)}%
                  <button onClick={() => { void window.opentype.localAsr.cancel().catch(() => { setFailed(true); setMessage('取消失败，请重试。') }) }}>取消准备</button>
                </> : <>
                  <span>{status?.error ?? (status?.state === 'checking' ? '正在校验模型…' : 'SenseVoice 模型尚未就绪')}</span>
                  <button disabled={preparing || !status || status.state === 'checking'} onClick={() => void download()}>准备 / 修复模型</button>
                </>}
            </div>
            <p className="note">说话时利用停顿提前识别，结束后补齐剩余内容并输出全文。优先使用安装包内的模型，缺失或损坏时才联网下载。模型来自 FunAudioLLM SenseVoice，经 sherpa-onnx 转换。</p>
          </>}
        </section>
        <section>
          <div className="section-title">
            <h2>DeepSeek 云端整理</h2>
            <label className="toggle"><input type="checkbox" checked={enabled} onChange={event => { changed(); setEnabled(event.target.checked) }} />启用</label>
          </div>
          <p>将识别文字发送到已配置的文字服务，去赘词、整理改口和标点。默认使用 DeepSeek 的 deepseek-flash；翻译和文字改写也由它完成。</p>
          <label className="key-label">
            整理服务 API Key
            <span>{clearKey ? '保存后清除现有密钥' : hasKey ? '已安全保存；留空保留，输入新密钥可替换' : '与 SiliconFlow 语音识别密钥分别保存'}</span>
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => { changed(); setKey(event.target.value); setClearKey(false) }} placeholder="输入 DeepSeek API Key" />
          </label>
          {hasKey && <button type="button" className="key-action" onClick={() => { changed(); setKey(''); setClearKey(!clearKey) }}>{clearKey ? '撤销清除密钥' : '清除已保存的密钥'}</button>}
          <p className="note">文字整理只发送识别文字，以及允许的输入框文字或选中文字。本地识别时音频留在本机，启用整理后文字仍会发送到云端。关闭整理可直接输出识别原文，翻译和改写不可用。</p>
          {enabled && !effectiveRefineKey && <p className="speech-warning">尚未配置整理密钥，听写将返回识别原文。</p>}
        </section>
      </fieldset>
      <footer>
        <span role={failed ? 'alert' : 'status'} className={failed ? 'speech-warning' : ''}>{message || (dirty ? '修改尚未保存，保存后从下一次听写生效。' : '')}</span>
        <button className="primary" disabled={!loaded || saving || conflict || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button>
      </footer>
    </main>
  )
}
