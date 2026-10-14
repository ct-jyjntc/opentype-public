import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { wireCaptureLifecycle } from './capture'
import { ColdStartSpeech, type ColdStartReason } from './components/cold-start-speech'
import { Icon } from './components/ui'
import { errorMessage, type VoiceState, type Preferences } from '../shared/desktop'
import type { CorrectionCandidate } from '../shared/corrections'
import './floating-bar.css'

const labels = {
  idle: '',
  preparing: '正在确认输入位置',
  recording: '正在录音',
  stopping: '正在收尾录音',
  encoding: '正在保存录音',
  uploading: '正在识别已说内容…',
  transcribing: '正在识别最后一段…',
  refining: '正在整理文字',
  injecting: '正在输入',
  done: '识别完成',
  error: '无法完成听写',
  cancelled: '已取消',
}
// Symmetric envelope: short at the edges, tall in the middle.
const wave = [5, 8, 12, 16, 19, 16, 12, 8, 5]
const activeCapturePhases = ['preparing', 'recording', 'stopping', 'encoding', 'uploading', 'transcribing', 'refining', 'injecting']
const cloudFailureDetails = new Set([
  'siliconflow_invalid_key',
  'siliconflow_insufficient_balance',
  'siliconflow_forbidden',
  'siliconflow_rate_limited',
  'siliconflow_network_error',
  'siliconflow_timeout',
  'siliconflow_unavailable',
  'siliconflow_model_unavailable',
  'siliconflow_redirect_refused',
])
const recoveryDetails = new Set([
  'injection_failed',
  'injection_target_changed',
  'injection_target_closed',
  'injection_app_changed',
  'injection_focus_unavailable',
  'injection_selection_changed',
  'injection_unverified',
  'injection_cancelled_after_send',
  'injection_already_sent',
  'injection_permission',
  'injection_elevated_target',
  'injection_clipboard_unavailable',
  'injection_keys_held',
  'injection_target_unavailable',
  'injection_target_not_editable',
  'injection_secure_target',
])

function FloatingBar() {
  const [state, setState] = useState<VoiceState>({ phase: 'idle' }),
    [seconds, setSeconds] = useState(0),
    [candidate, setCandidate] = useState<CorrectionCandidate | null>(null),
    [candidateScope, setCandidateScope] = useState<string>(),
    [candidateBusy, setCandidateBusy] = useState(false),
    [analysisFallback, setAnalysisFallback] = useState<'not_configured' | 'request_failed'>(),
    [feedback, setFeedback] = useState(''),
    [feedbackTitle, setFeedbackTitle] = useState(''),
    [coldStart, setColdStart] = useState<ColdStartReason | null>(null),
    [coldDetail, setColdDetail] = useState<string>(),
    [provider, setProvider] = useState<string>('siliconflow'),
    [copied, setCopied] = useState(false)
  const preferences = useRef<Preferences>()
  const device = useRef('default'),
    started = useRef(0),
    sessionId = useRef(''),
    stateRef = useRef<VoiceState>({ phase: 'idle' }),
    candidateRef = useRef<CorrectionCandidate | null>(null),
    candidateGeneration = useRef(0),
    candidateAction = useRef(false),
    deferredRetraction = useRef(''),
    feedbackTimer = useRef<ReturnType<typeof setTimeout>>(),
    hideBarTimer = useRef<ReturnType<typeof setTimeout>>(),
    feedbackRef = useRef(''),
    correctionSessionRef = useRef(false),
    coldStartRef = useRef<ColdStartReason | null>(null)

  const updateCandidate = (value: CorrectionCandidate | null) => {
    candidateRef.current = value
    setCandidate(value)
    window.opentype.desktop.corrections.setCapsuleCandidate(value?.id)
  }
  const updateFeedback = (value: string) => {
    feedbackRef.current = value
    setFeedback(value)
  }
  const setCold = useCallback((reason: ColdStartReason | null, detail?: string) => {
    coldStartRef.current = reason
    setColdStart(reason)
    setColdDetail(detail)
    if (reason) void window.opentype.window.showBar()
  }, [])
  const hideWhenSettled = (delay = 0) => {
    clearTimeout(hideBarTimer.current)
    hideBarTimer.current = setTimeout(() => {
      if (coldStartRef.current) return
      if (activeCapturePhases.includes(stateRef.current.phase) || candidateRef.current || feedbackRef.current) return
      void window.opentype.window.hideBar()
    }, delay)
  }
  const dismissColdStart = useCallback(() => {
    setCold(null)
    setState({ phase: 'idle' })
    stateRef.current = { phase: 'idle' }
    void window.opentype.window.hideBar()
  }, [setCold])
  const restoreNextCandidate = async (historyId: string, expectedScope: string, generation: number) => {
    try {
      const snapshot = await window.opentype.desktop.dictionary.snapshot()
      if (snapshot.scope !== expectedScope) return
      const pending = await window.opentype.desktop.corrections.list(0, historyId)
      const afterList = await window.opentype.desktop.dictionary.snapshot()
      if (candidateGeneration.current !== generation || candidateRef.current
        || activeCapturePhases.includes(stateRef.current.phase) || afterList.scope !== expectedScope) return
      const next = pending.items.find(item => item.sourceKind === 'input_edit')
      if (!next) return
      updateCandidate(next)
      setCandidateScope(expectedScope)
      updateFeedback('')
      setFeedbackTitle('')
      correctionSessionRef.current = true
      clearTimeout(hideBarTimer.current)
    } catch { /* the dictionary page remains the fallback review path */ }
  }
  useEffect(() => {
    void window.opentype.config
      .get()
      .then((c) => {
        device.current = c.micDeviceId
        setProvider(c.provider)
      })
    const offConfig = window.opentype.config.onChanged((c) => {
      device.current = c.micDeviceId
      setProvider(c.provider)
      if (c.provider === 'local' && coldStartRef.current) dismissColdStart()
    })
    const offProvider = window.opentype.speech.onProviderChanged((value) => {
      setProvider(value)
      if (value === 'local' && coldStartRef.current) dismissColdStart()
    })
    void window.opentype.desktop.snapshot().then(s => { preferences.current = s.preferences }).catch(()=>{})
    const offPreferences = window.opentype.desktop.onPreferences(p => { preferences.current = p })
    const offCapture = wireCaptureLifecycle(() => device.current, () => preferences.current)
    const off = window.opentype.desktop.recording.onState((s) => {
      stateRef.current = s
      if (s.phase === 'recording' && s.audioId !== sessionId.current) {
        sessionId.current = s.audioId ?? ''
        started.current = Date.now()
        setSeconds(0)
      }
      if (activeCapturePhases.includes(s.phase)) {
        clearTimeout(hideBarTimer.current)
        clearTimeout(feedbackTimer.current)
        candidateGeneration.current++
        updateCandidate(null)
        setCandidateScope(undefined)
        setAnalysisFallback(undefined)
        deferredRetraction.current = ''
        correctionSessionRef.current = false
        updateFeedback('')
        setFeedbackTitle('')
        setCopied(false)
        setCold(null)
      }
      // N1 gate: missing Key → dual CTA immediately (never start mic / never auto-install).
      // Cloud runtime failures stay on the error pill with an explicit「改用本地」.
      if (s.phase === 'error' && s.detail === 'siliconflow_key_required') {
        setCold('missing_key', s.detail)
      }
      setState(s)
    })
    const offCandidate = window.opentype.desktop.corrections.onCapsuleCandidate(({ candidate: next, candidateId, scope, analysisFallback: fallback }) => {
      if (next && candidateRef.current?.id === next.id) return
      if (!next) {
        const targetId = candidateId
        if (!candidateRef.current || targetId !== candidateRef.current.id) return
        if (candidateAction.current) {
          deferredRetraction.current = targetId
          return
        }
      }
      clearTimeout(feedbackTimer.current)
      clearTimeout(hideBarTimer.current)
      candidateGeneration.current++
      if (next) correctionSessionRef.current = true
      updateCandidate(next)
      setCandidateScope(next ? scope : undefined)
      setAnalysisFallback(next ? fallback : undefined)
      updateFeedback('')
      setFeedbackTitle('')
      if (!next) hideWhenSettled()
    })
    return () => {
      off()
      offCandidate()
      offCapture()
      offConfig()
      offProvider()
      offPreferences()
      clearTimeout(feedbackTimer.current)
      clearTimeout(hideBarTimer.current)
    }
  }, [dismissColdStart, setCold])
  useEffect(() => {
    if (state.phase !== 'recording') return
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started.current) / 1000)),
      1000,
    )
    return () => clearInterval(timer)
  }, [state.phase])
  const captureBusy = activeCapturePhases.includes(state.phase)
  const acceptCandidate = async () => {
    const activeCandidate = candidateRef.current
    if (!activeCandidate || candidateAction.current || captureBusy) return
    const activeScope = candidateScope
    candidateAction.current = true
    setCandidateBusy(true)
    try {
      await window.opentype.desktop.corrections.accept(activeCandidate.id, activeCandidate.replacement, activeCandidate.original, candidateScope)
      if (candidateRef.current?.id !== activeCandidate.id) return
      updateCandidate(null)
      setCandidateScope(undefined)
      restoreNextCandidate(activeCandidate.historyId, activeScope ?? '', ++candidateGeneration.current)
      updateFeedback('已加入词典')
      setFeedbackTitle('')
      feedbackTimer.current = setTimeout(() => {
        if (candidateRef.current || activeCapturePhases.includes(stateRef.current.phase) || feedbackRef.current !== '已加入词典') return
        updateFeedback('')
        hideWhenSettled()
      }, 1300)
    } catch (error) {
      if (candidateRef.current?.id !== activeCandidate.id) return
      const detail = errorMessage(error)
      const scopeChanged = error instanceof Error && error.message === 'dictionary_scope_changed'
      const retractedDuringAction = deferredRetraction.current === activeCandidate.id
      if (scopeChanged) {
        updateCandidate(null)
        setCandidateScope(undefined)
        correctionSessionRef.current = true
      }
      updateFeedback(`加入失败：${detail}`)
      setFeedbackTitle(detail)
      feedbackTimer.current = setTimeout(() => {
        if (activeCapturePhases.includes(stateRef.current.phase) || feedbackRef.current !== `加入失败：${detail}`) return
        if (candidateRef.current?.id === activeCandidate.id || ((scopeChanged || retractedDuringAction) && !candidateRef.current)) {
          updateFeedback('')
          if (!candidateRef.current) hideWhenSettled()
        }
      }, 2200)
    } finally {
      if (deferredRetraction.current === activeCandidate.id) {
        if (candidateRef.current?.id === activeCandidate.id) {
          updateCandidate(null)
          setCandidateScope(undefined)
          correctionSessionRef.current = true
          if (!feedbackRef.current) hideWhenSettled()
        }
        deferredRetraction.current = ''
      }
      candidateAction.current = false
      setCandidateBusy(false)
    }
  }
  const dismissCandidate = async () => {
    const activeCandidate = candidateRef.current
    if (!activeCandidate || candidateAction.current || captureBusy) return
    const activeScope = candidateScope
    candidateAction.current = true
    setCandidateBusy(true)
    try {
      await window.opentype.desktop.corrections.dismiss(activeCandidate.id)
      if (candidateRef.current?.id === activeCandidate.id) {
        updateCandidate(null)
        setCandidateScope(undefined)
        restoreNextCandidate(activeCandidate.historyId, activeScope ?? '', ++candidateGeneration.current)
        correctionSessionRef.current = true
        updateFeedback('')
        setFeedbackTitle('')
        hideWhenSettled()
      }
    } catch (error) {
      if (candidateRef.current?.id !== activeCandidate.id) return
      const detail = errorMessage(error)
      const retractedDuringAction = deferredRetraction.current === activeCandidate.id
      updateFeedback(`关闭失败：${detail}`)
      setFeedbackTitle(detail)
      feedbackTimer.current = setTimeout(() => {
        if (activeCapturePhases.includes(stateRef.current.phase) || feedbackRef.current !== `关闭失败：${detail}`) return
        if (candidateRef.current?.id === activeCandidate.id || (retractedDuringAction && !candidateRef.current)) {
          updateFeedback('')
          if (!candidateRef.current) hideWhenSettled()
        }
      }, 2200)
    } finally {
      if (deferredRetraction.current === activeCandidate.id) {
        if (candidateRef.current?.id === activeCandidate.id) {
          updateCandidate(null)
          setCandidateScope(undefined)
          correctionSessionRef.current = true
          if (!feedbackRef.current) hideWhenSettled()
        }
        deferredRetraction.current = ''
      }
      candidateAction.current = false
      setCandidateBusy(false)
    }
  }

  if (coldStart) {
    return (
      <ColdStartSpeech
        reason={coldStart}
        detail={coldDetail}
        onDismiss={dismissColdStart}
        onEnabledLocal={dismissColdStart}
      />
    )
  }

  if (!captureBusy && candidate && state.phase !== 'error' && state.phase !== 'cancelled') {
    return (
      <div className="correction-pill" role="status" aria-label={`${candidate.original} 改为 ${candidate.replacement}`}>
        <span className="correction-word" title={candidate.original}>{candidate.original}</span>
        <span className="correction-arrow" aria-hidden="true">→</span>
        <span className="correction-word" title={candidate.replacement}>{candidate.replacement}</span>
        <button className="correction-accept" disabled={candidateBusy} onMouseDown={e => e.preventDefault()} onClick={() => void acceptCandidate()}
          title={analysisFallback === 'not_configured' ? '未启用 AI，使用本地识别'
            : analysisFallback === 'request_failed' ? 'AI暂不可用，使用本地识别；请检查 DeepSeek 设置'
            : feedbackTitle || '加入词典'}>
          {feedback || '加入词典'}
        </button>
        <button className="correction-dismiss" disabled={candidateBusy} onMouseDown={e => e.preventDefault()} onClick={() => void dismissCandidate()} aria-label="关闭此纠词提示" title="关闭此提示">
          <Icon name="close" size={14} />
        </button>
      </div>
    )
  }
  if (!captureBusy && !candidate && feedback && state.phase !== 'error' && state.phase !== 'cancelled') {
    return <div className="correction-pill correction-feedback" role="status" title={feedbackTitle}>{feedback}</div>
  }
  if (!captureBusy && correctionSessionRef.current && !candidate && !feedback && state.phase === 'done') return null
  if (state.phase === 'idle') return null

  const mode = state.mode === 'voice_translation' ? 'translate' : state.mode === 'voice_command' ? 'ask' : 'dictate'
  const suppressDoneInjectionNotice = state.phase === 'done'
    && (state.detail === 'injection_unverified' || state.detail === 'injection_cancelled_after_send' || state.detail === 'injection_already_sent')
  const noticeText = [...new Set([suppressDoneInjectionNotice ? undefined : state.detail, state.audioNotice].filter(Boolean).map(errorMessage))].join('；')
  const errorText = state.phase === 'error' ? noticeText || labels.error : ''
  const label = state.phase === 'error' ? errorText.split(/[，。,]/)[0]
    : state.phase === 'done' && state.detail === 'microphone_disconnected_saved' ? '录音提前结束'
    : state.phase === 'done' && noticeText ? noticeText.split(/[，。,；]/)[0]
    : state.phase === 'refining' && mode === 'translate' ? '正在翻译'
    : state.phase === 'refining' && mode === 'ask' ? '正在思考'
    : state.phase === 'uploading' && (state.completedSegments ?? 0) > 0 ? '正在识别已说内容…'
    : labels[state.phase]
  const phaseHint = state.phase === 'recording'
    ? (state.stopGesture === 'release' ? '松开快捷键结束，Esc 取消' : '再次按下快捷键结束，Esc 取消')
    : errorText || label
  const hint = [...new Set([phaseHint, noticeText].filter(Boolean))].join('；')

  const showRecovery = Boolean(state.text?.trim())
    && ((state.phase === 'done' && state.detail && recoveryDetails.has(state.detail))
      || (state.phase === 'error' && state.detail && recoveryDetails.has(state.detail)))
  const showSwitchLocal = state.phase === 'error'
    && state.detail
    && cloudFailureDetails.has(state.detail)
    && provider === 'siliconflow'

  if (showRecovery) {
    return (
      <div className="recovery-pill" role="status" aria-label={hint} title={hint}>
        <span className="bar-label">{label || '文字未插入'}</span>
        <button
          className="recovery-primary"
          onMouseDown={e => e.preventDefault()}
          onClick={() => {
            void window.opentype.desktop.copy(state.text ?? '').then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }).catch(() => {})
          }}
        >
          {copied ? '已复制' : '复制文字'}
        </button>
        <button
          className="recovery-secondary"
          onMouseDown={e => e.preventDefault()}
          onClick={() => void window.opentype.desktop.openHub('history')}
        >
          打开历史
        </button>
        <button className="bar-cancel" aria-label="关闭" onClick={() => hideWhenSettled(0)}>
          <Icon name="close" size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className={`recording-pill ${state.phase} mode-${mode}`} role="status" aria-label={hint} title={hint}>
      <button
        className="bar-cancel"
        aria-label={state.phase === 'preparing' ? '取消开始' : state.phase === 'recording' ? '取消录音' : '取消处理'}
        onClick={() => void window.opentype.capture.cancel()}
      >
        <Icon name="close" size={16} />
      </button>
      <div className="bar-content">
        {state.phase === 'recording' ? (
          <div className="waveform">
            {wave.map((base, i) => (
              <i
                key={i}
                style={{
                  height: `${3 + Math.min(1, (state.level ?? 0) / 0.1) * base * (0.75 + 0.25 * Math.sin(Math.abs(i - 4) * 1.3 + seconds * 2))}px`,
                }}
              />
            ))}
          </div>
        ) : (
          <span className="bar-label">{label}</span>
        )}
        {noticeText && state.phase === 'recording' && (
          <span className="bar-warning"><Icon name="info" size={15} /></span>
        )}
      </div>
      {state.phase === 'recording' ? (
        <button
          className="bar-stop"
          aria-label="结束录音"
          onClick={() => void window.opentype.capture.stop()}
        >
          <Icon name="check" size={17} />
        </button>
      ) : showSwitchLocal ? (
        <button
          className="bar-switch-local"
          onMouseDown={e => e.preventDefault()}
          onClick={() => setCold('cloud_failed', state.detail)}
        >
          改用本地
        </button>
      ) : (
        <span className={`bar-state${noticeText ? ' has-notice' : ''}`}>
          <Icon name={noticeText || state.phase === 'error' ? 'info' : state.phase === 'done' ? 'check' : 'loader'} size={16} />
        </span>
      )}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<FloatingBar />)
