import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { wireCaptureLifecycle } from './capture'
import { Icon } from './components/ui'
import { errorMessage, type VoiceState, type Preferences } from '../shared/desktop'
import './floating-bar.css'
const labels = {
  idle: '',
  preparing: '正在确认输入位置',
  recording: '正在聆听',
  stopping: '正在收尾录音',
  encoding: '正在保存录音',
  uploading: '正在识别',
  transcribing: '正在识别最后片段',
  refining: '正在整理文字',
  injecting: '正在输入',
  done: '已完成',
  error: '无法完成听写',
  cancelled: '已取消',
}
function FloatingBar() {
  const [state, setState] = useState<VoiceState>({ phase: 'idle' }),
    [seconds, setSeconds] = useState(0)
  const preferences = useRef<Preferences>()
  const device = useRef('default'),
    started = useRef(0),
    sessionId = useRef('')
  useEffect(() => {
    void window.opentype.config
      .get()
      .then((c) => (device.current = c.micDeviceId))
    const offConfig = window.opentype.config.onChanged(
      (c) => (device.current = c.micDeviceId),
    )
    void window.opentype.desktop.snapshot().then(s => { preferences.current = s.preferences }).catch(()=>{})
    const offPreferences = window.opentype.desktop.onPreferences(p => { preferences.current = p })
    const offCapture = wireCaptureLifecycle(() => device.current, () => preferences.current)
    const off = window.opentype.desktop.recording.onState((s) => {
      if (s.phase === 'recording' && s.audioId !== sessionId.current) {
        sessionId.current = s.audioId ?? ''
        started.current = Date.now()
        setSeconds(0)
      }
      setState(s)
    })
    return () => {
      off()
      offCapture()
      offConfig()
      offPreferences()
    }
  }, [])
  useEffect(() => {
    if (state.phase !== 'recording') return
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started.current) / 1000)),
      1000,
    )
    return () => clearInterval(timer)
  }, [state.phase])
  if (state.phase === 'idle') return null
  // Mode is shown by colour only: dictation white, translation blue, ask-anything green.
  const mode = state.mode === 'voice_translation' ? 'translate' : state.mode === 'voice_command' ? 'ask' : 'dictate'
  const noticeText = [...new Set([state.detail, state.audioNotice].filter(Boolean).map(errorMessage))].join('；')
  const errorText = state.phase === 'error' ? noticeText || labels.error : ''
  // The capsule has room for one short clause; the full reason stays in the tooltip.
  const label = state.phase === 'error' ? errorText.split(/[，。,]/)[0]
    : state.phase === 'done' && state.detail === 'microphone_disconnected_saved' ? '录音提前结束'
    : state.phase === 'done' && state.detail?.startsWith('injection_') ? '请核对输入结果'
    : state.phase === 'done' && noticeText ? noticeText.split(/[，。,；]/)[0]
    : state.phase === 'refining' && mode === 'translate' ? '正在翻译'
    : state.phase === 'refining' && mode === 'ask' ? '正在思考'
    : labels[state.phase]
  const phaseHint = state.phase === 'recording'
    ? (state.stopGesture === 'release' ? '松开快捷键结束，Esc 取消' : '再次按下快捷键结束，Esc 取消')
    : errorText || label
  const hint = [...new Set([phaseHint, noticeText].filter(Boolean))].join('；')
  return (
    <div className={`recording-pill ${state.phase} mode-${mode}`} role="status" aria-label={hint} title={hint}>
      <button
        className="bar-cancel"
        aria-label={state.phase === 'preparing' ? '取消开始' : state.phase === 'recording' ? '取消录音' : '取消处理'}
        onClick={() => void window.opentype.capture.cancel()}
      >
        <Icon name="close" size={15} />
      </button>
      <div className="bar-content">
        {state.phase === 'recording' ? (
          <div className="waveform">
            {Array.from({ length: 17 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${4 + Math.min(1, (state.level ?? 0) / 0.1) * (8 + Math.sin(i * 2 + seconds) * 8)}px`,
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
          <span />
        </button>
      ) : (
        <span className={`bar-state${noticeText ? ' has-notice' : ''}`}>
          <Icon name={noticeText || state.phase === 'error' ? 'info' : state.phase === 'done' ? 'check' : 'spark'} size={16} />
        </span>
      )}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<FloatingBar />)
