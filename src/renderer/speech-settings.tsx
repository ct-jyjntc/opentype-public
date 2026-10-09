import { useEffect, useState } from 'react'
import type { ModelStatus } from '../main/services/local-asr/model-store'

export function SpeechSettings({ embedded = false }: { embedded?: boolean }) {
  const [enabled, setEnabled] = useState(true)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [status, setStatus] = useState<ModelStatus>()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    let active = true
    window.opentype.config
      .get()
      .then((config) => {
        if (!active) return
        setEnabled(config.enableRefine)
        setHasKey(config.hasRefineApiKey)
        setLoaded(true)
      })
      .catch(() => setMessage('无法读取设置，请重新打开此窗口。'))
    const refresh = () =>
      window.opentype.localAsr
        .status()
        .then((value) => {
          if (active) setStatus(value)
        })
        .catch(() => { if (active) setMessage('无法读取模型状态，请重新打开设置。') })
    void refresh()
    const interval = setInterval(refresh, 1000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])
  const download = async () => {
    setMessage('')
    setPreparing(true)
    setStatus((previous) => ({
      state: 'checking',
      downloaded: 0,
      total: previous?.total ?? 239549735,
    }))
    try {
      setStatus(await window.opentype.localAsr.install())
    } catch {
      setMessage('模型准备未完成，请先结束听写后重试。')
    } finally { setPreparing(false) }
  }
  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const result = await window.opentype.config.set({
        provider: 'local',
        sttModel: 'sensevoice-small-int8',
        enableRefine: enabled,
        refineBaseUrl: 'https://api.deepseek.com',
        refineModel: 'deepseek-flash',
        ...(key.trim() ? { refineApiKey: key.trim() } : {}),
      })
      setKey('')
      setHasKey(result.hasRefineApiKey)
      setMessage('设置已保存，下一次听写生效。')
    } catch {
      setMessage('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <main className={`speech-settings ${embedded ? 'embedded' : ''}`}>
      <h1>本地低延迟听写</h1>
      <p className="intro">
        使用 SenseVoice Small 在本机识别，短句和长录音都支持，不设录音时长上限。
      </p>
      <section>
        <h2>语音识别模型</h2>
        <div className="choice selected">
          <span>
            <strong>SenseVoice Small <em>低延迟</em></strong>
            <small>支持普通话、粤语、英语、日语和韩语。模型约 240 MB，音频在本机处理。</small>
          </span>
        </div>
        <div className={`model-status ${status?.state === 'ready' ? 'ready' : status?.error ? 'error' : status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking' ? 'busy' : 'pending'}`} aria-live="polite">
          {status?.state === 'ready' ? (
            '✓ SenseVoice 模型已就绪，文件校验通过'
          ) : status?.state === 'downloading' || status?.state === 'installing' ? (
            <>
              <progress value={status.downloaded} max={status.total} /> {status.state === 'installing' ? '正在从安装包准备模型' : '正在下载模型'}{' '}
              {Math.floor((status.downloaded / status.total) * 100)}%
              <button onClick={() => { void window.opentype.localAsr.cancel().catch(() => setMessage('取消失败，请重试。')) }}>取消准备</button>
            </>
          ) : (
            <>
              <span>
                {status?.error ??
                  (status?.state === 'checking'
                    ? '正在校验模型…'
                    : 'SenseVoice 模型尚未就绪')}
              </span>
              <button
                disabled={preparing || !status || status.state === 'checking'}
                onClick={download}
              >
                准备 / 修复模型
              </button>
            </>
          )}
        </div>
        <p className="note">
          说话时会利用停顿提前识别，结束后补齐剩余内容并输出全文，减少长听写的等待。
          优先使用安装包内的模型，缺失或损坏时才联网下载。模型来自 FunAudioLLM SenseVoice，经 sherpa-onnx 转换。
        </p>
      </section>
      <section>
        <div className="section-title">
          <h2>DeepSeek 云端整理</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            启用
          </label>
        </div>
        <p>
          将识别文字发送到 DeepSeek 官方，去赘词、整理改口和标点。使用
          deepseek-flash，关闭思考。翻译和文字改写也由它完成。
        </p>
        <label className="key-label">
          API Key {hasKey && <span>已安全保存；留空保留现有密钥</span>}
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="输入 DeepSeek API Key"
          />
        </label>
        <p className="note">
          原始音频留在本机；相关输入框文字或选中文字会用于整理和改写。关闭后可使用未经整理的本地听写，翻译和改写不可用。
        </p>
      </section>
      <footer>
        <span role="status">
          {message ||
            (enabled && !hasKey && !key.trim()
              ? '尚未设置密钥，将返回本地识别原文。'
              : '')}
        </span>
        <button
          className="primary"
          disabled={
            !loaded ||
            saving
          }
          onClick={save}
        >
          {saving ? '正在保存…' : '保存设置'}
        </button>
      </footer>
    </main>
  )
}
