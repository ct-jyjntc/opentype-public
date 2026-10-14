import { useEffect, useRef, useState } from 'react'
import type { ModelStatus } from '../../main/services/local-asr/model-store'
import { errorMessage } from '../../shared/desktop'
import {
  busyModelState,
  cancelLocalAsrInstall,
  enableLocalRecognitionProvider,
  progressPercent,
  runLocalAsrInstall,
} from '../local-asr-install'
import { Icon } from './ui'

export type ColdStartReason = 'missing_key' | 'cloud_failed'

type Props = {
  reason: ColdStartReason
  detail?: string
  onDismiss: () => void
  onEnabledLocal?: () => void
}

/**
 * N1 cold-start dual CTA.
 * Primary: download/enable local INT8 (only setProvider local after ready).
 * Secondary: open speech settings for cloud Key (no install, no provider change).
 * Cancel / fail / close: zero config writes.
 */
export function ColdStartSpeech({ reason, detail, onDismiss, onEnabledLocal }: Props) {
  const [status, setStatus] = useState<ModelStatus>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState('')
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    void window.opentype.desktop.setBarExpanded?.(true)
    const offState = window.opentype.localAsr.onState(value => {
      if (mountedRef.current) setStatus(value)
    })
    const offProvider = window.opentype.speech.onProviderChanged(provider => {
      if (mountedRef.current && provider === 'local') onEnabledLocal?.()
    })
    void window.opentype.localAsr.check().then(value => {
      if (mountedRef.current) setStatus(value)
    }).catch(() => {})
    return () => {
      mountedRef.current = false
      offState()
      offProvider()
      void window.opentype.desktop.setBarExpanded?.(false)
    }
  }, [onEnabledLocal])

  const runPrimary = async () => {
    if (busy) return
    cancelledRef.current = false
    setBusy(true)
    setFailed(false)
    setMessage('')
    const result = await runLocalAsrInstall({
      onStatus: value => { if (mountedRef.current) setStatus(value) },
      isCancelled: () => cancelledRef.current,
    })
    if (!mountedRef.current) return
    if (result.outcome === 'cancelled') {
      setMessage('已取消，仍使用云端。')
      setBusy(false)
      return
    }
    if (result.outcome !== 'ready') {
      setFailed(true)
      setMessage(errorMessage(result.error || result.status?.error || '模型准备失败'))
      setBusy(false)
      return
    }
    try {
      await enableLocalRecognitionProvider()
      if (!mountedRef.current) return
      setMessage('本地模型已启用')
      onEnabledLocal?.()
    } catch (error) {
      if (mountedRef.current) {
        setFailed(true)
        setMessage(errorMessage(error))
      }
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const cancel = async () => {
    cancelledRef.current = true
    setMessage('正在取消…')
    try { await cancelLocalAsrInstall() }
    catch (error) {
      if (mountedRef.current) { setFailed(true); setMessage(errorMessage(error)) }
    }
  }

  const openKeySettings = () => {
    // Secondary CTA: open speech settings focused on Key; do not install or change provider.
    void window.opentype.desktop.openSpeechSettings()
    onDismiss()
  }

  const percent = progressPercent(status)
  const installing = busyModelState(status) || busy
  const title = reason === 'cloud_failed' ? '云端识别暂不可用' : '开始听写前先选一条路'
  const description = reason === 'cloud_failed'
    ? (detail ? errorMessage(detail) : '可以改用本地 INT8，或回设置检查 Key 与网络。')
    : '默认云端识别需要 SiliconFlow API Key。也可以下载本地 INT8 模型离线使用（约 240 MB）。'

  return (
    <div className="cold-start-card" role="dialog" aria-label={title}>
      <button className="cold-start-close" aria-label="关闭" onClick={onDismiss}>
        <Icon name="close" size={14} />
      </button>
      <strong className="cold-start-title">{title}</strong>
      <p className="cold-start-desc">{description}</p>
      {installing && (
        <div className="cold-start-progress" role="status" aria-live="polite">
          {status?.state === 'downloading' ? (
            <>
              <progress value={status.downloaded} max={status.total || 1} />
              <span>下载中 {percent}%</span>
            </>
          ) : status?.state === 'installing' ? <span>正在启用包内模型…</span>
            : status?.state === 'checking' ? <span>正在检查本地模型…</span>
              : <span>正在准备本地模型…</span>}
          <button type="button" className="text-button" disabled={!busy && !busyModelState(status)} onClick={() => void cancel()}>取消</button>
        </div>
      )}
      {message && <p className={`cold-start-msg ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>{message}</p>}
      <div className="cold-start-actions">
        <button
          type="button"
          className="cold-start-primary"
          disabled={installing}
          onClick={() => void runPrimary()}
        >
          {status?.state === 'ready' && !installing ? '启用本地 INT8' : '下载并启用本地 INT8'}
        </button>
        <button
          type="button"
          className="cold-start-secondary"
          disabled={installing}
          onClick={openKeySettings}
        >
          填写 Key 走云端
        </button>
      </div>
    </div>
  )
}
