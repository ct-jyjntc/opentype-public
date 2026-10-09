import { useEffect, useState } from 'react'
import { errorMessage } from '../../shared/desktop'
import { Modal } from './ui'
import { shortcutLabel } from '../shortcut-label'
const api = window.opentype.desktop.keyboard
export function ShortcutRecorder({ current, onSave, onClose }: {
  current: string
  onSave: (shortcut: string) => Promise<boolean>
  onClose: () => void
}) {
  const [id] = useState(() => crypto.randomUUID())
  const [value, setValue] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const begin = async () => {
    setError('')
    try { await api.beginCapture(id); setListening(true) }
    catch (e) { setError(errorMessage(e)); setListening(false) }
  }
  useEffect(() => {
    let mounted = true
    const off = api.onCapture(state => {
      if (state.id !== id) return
      setListening(state.active)
      if (state.shortcut) { setValue(state.shortcut); setError('') }
      if (state.reason === 'cancelled') onClose()
    })
    void api.beginCapture(id).then(() => { if (mounted) setListening(true) })
      .catch(e => { if (mounted) setError(errorMessage(e)) })
    return () => { mounted = false; off(); void api.endCapture(id) }
  }, [id])
  return <Modal title="修改快捷键" onClose={onClose}>
    <form className="dialog-body" onSubmit={async e => {
      e.preventDefault()
      if (!value || saving) return
      setSaving(true)
      try {
        if (await onSave(value)) { await api.endCapture(id); onClose() }
      } finally { setSaving(false) }
    }}>
      <p className="muted">当前快捷键：{shortcutLabel(current)}</p>
      <button type="button" className="shortcut-recorder" aria-label="录入快捷键" onClick={() => void begin()}>
        <kbd>{value ? shortcutLabel(value) : '请按下新的快捷键'}</kbd>
        <span>{listening ? '正在监听按键，听写快捷键已暂停' : '点击此处重新录入'}</span>
      </button>
      <p className="muted">{window.opentype.platform === 'darwin' ? '直接按右 Command、Fn、F8 或组合键即可录入。' : '直接按右 Ctrl、F8 或组合键即可录入。'}再次按键可替换；Esc 取消。</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button className="primary" disabled={!value || saving}>{saving ? '正在保存…' : '保存'}</button>
      </div>
    </form>
  </Modal>
}
