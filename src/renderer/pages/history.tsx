import { useCallback, useEffect, useRef, useState } from 'react'
import { Empty, Icon, IconButton, Menu, Modal } from '../components/ui'
import { AudioStorageDialog } from '../components/audio-storage'
import { errorMessage, parseMeta, type HistoryItem } from '../../shared/desktop'
const api = window.opentype.desktop
const durationLabel = (value: number | null | undefined) => value == null ? '时长未知' : `${Math.round(value)} 秒`
const modes = [
  ['', '全部'],
  ['voice_transcript', '听写'],
  ['voice_translation', '翻译'],
  ['voice_command', '随便问'],
]
export function HistoryPage({ notify }: { notify: (text: string) => void }) {
  const [rows, setRows] = useState<HistoryItem[]>([]),
    [query, setQuery] = useState(''),
    [mode, setMode] = useState(''),
    [hasMore, setMore] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<HistoryItem | null>(null),
    [retention, setRetention] = useState(90)
  const [storageOpen, setStorageOpen] = useState(false)
  const generation = useRef(0)
  const load = useCallback(
    async (offset = 0) => {
      const gen = ++generation.current
      setLoading(true)
      setError('')
      try {
        const r = await api.history.list(offset, 50, query, mode)
        if (gen !== generation.current) return
        setRows((prev) => (offset ? [...prev, ...r.data] : r.data))
        setMore(r.hasMore)
      } catch (e) {
        if (gen === generation.current) setError(errorMessage(e))
      } finally {
        if (gen === generation.current) setLoading(false)
      }
    },
    [query, mode],
  )
  useEffect(() => {
    const t = setTimeout(() => void load(), 180)
    const off = api.onHistory(() => void load())
    return () => {
      clearTimeout(t)
      generation.current++
      off()
    }
  }, [load])
  useEffect(() => {
    void window.opentype.config
      .get()
      .then((c) => setRetention(c.historyRetentionDays))
  }, [])
  return (
    <>
      <div className="page-heading">
        <h1>历史记录</h1>
        <button onClick={() => setStorageOpen(true)}>管理录音存储</button>
        <IconButton
          name="refresh"
          label="刷新历史"
          onClick={() => void load()}
        />
      </div>
      <div className="retention-panel">
        <div>
          <strong>保存历史</strong>
          <p>选择在此设备上保留历史记录的时间。</p>
        </div>
        <select
          aria-label="历史保留时间"
          value={retention}
          onChange={async (e) => {
            const value = Number(e.target.value)
            try {
              await window.opentype.config.set({ historyRetentionDays: value })
              setRetention(value)
              notify('历史保留时间已保存')
            } catch (e) {
              notify(errorMessage(e))
              // The preference can be saved even when audio cleanup needs a retry.
              void window.opentype.config.get().then(c => setRetention(c.historyRetentionDays))
            }
          }}
        >
          <option value={-1}>永远</option>
          <option value={90}>90 天</option>
          <option value={30}>30 天</option>
          <option value={7}>7 天</option>
        </select>
      </div>
      <div className="list-toolbar">
        <div className="tabs">
          {modes.map(([v, l]) => (
            <button
              key={v}
              className={mode === v ? 'active' : ''}
              onClick={() => setMode(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索历史"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <div className="error-panel" role="alert">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      ) : rows.length === 0 ? (
        <Empty
          icon="history"
          title={loading ? '正在加载…' : query ? '没有匹配的口述' : '尚无口述'}
          description={
            query
              ? '尝试其他关键词。'
              : '一旦您在不同应用中进行口述，您的所有口述历史将出现在这里。'
          }
        />
      ) : (
        <div className="history-list">
          {rows.map((row) => (
            <button
              className="history-row"
              key={row.id}
              onClick={() => setSelected(row)}
            >
              <div className="history-meta">
                <span>
                  <em className={`mode-tag ${row.mode}`}>{modes.find(([v]) => v === row.mode)?.[1]}</em>
                  {row.focusedAppName || 'OpenType'}
                </span>
                <time>
                  {row.createdAt
                    ? new Date(row.createdAt).toLocaleString('zh-CN')
                    : ''}
                </time>
              </div>
              <p>
                {row.editedText ??
                  row.refinedText ??
                  parseMeta(row.modeMeta).raw_text ??
                  (parseMeta(row.modeMeta).recovered_audio ? '找回的录音，尚未识别' : '未生成文字')}
              </p>
              <div className="history-status">
                <span>{durationLabel(row.duration)}</span>
                {typeof parseMeta(row.modeMeta).skill_name === 'string' && <span>{parseMeta(row.modeMeta).skill_name}</span>}
                {parseMeta(row.modeMeta).input_delivery === 'failed' && <span className="warning">文字已生成 · 待复制</span>}
                {parseMeta(row.modeMeta).input_delivery === 'unverified' && <span className="warning">已尝试发送 · 请核对输入框</span>}
                {row.status !== 'completed' && (
                  <span className="warning">
                    {parseMeta(row.modeMeta).recovered_audio
                      ? '已找回录音 · 可识别'
                      : row.status === 'cancelled'
                      ? '已取消 · 录音已保留'
                      : '识别失败 · 可重试'}
                  </span>
                )}
                <Icon name="arrow" size={16} />
              </div>
            </button>
          ))}
        </div>
      )}
      {hasMore && (
        <button
          className="load-more"
          disabled={loading}
          onClick={() => void load(rows.length)}
        >
          {loading ? '正在加载…' : '加载更多'}
        </button>
      )}
      <p className="page-footnote"><Icon name="lock" size={13} />历史记录只保存在这台设备。云端同步需要您手动开启；启用 DeepSeek 时，识别出的文字会发送到它的官方服务。</p>
      {storageOpen && <AudioStorageDialog onClose={() => setStorageOpen(false)} notify={notify} />}
      {selected && (
        <HistoryDialog
          item={selected}
          onClose={() => setSelected(null)}
          onChange={() => void load()}
          notify={notify}
        />
      )}
    </>
  )
}
export function HistoryDialog({
  item,
  onClose,
  onChange,
  notify,
}: {
  item: HistoryItem
  onClose: () => void
  onChange: () => void
  notify: (s: string) => void
}) {
  const [record, setRecord] = useState(item),
    [audio, setAudio] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [canDeleteCloud, setCanDeleteCloud] = useState(false),
    [deleteCloud, setDeleteCloud] = useState(false),
    [text, setText] = useState(item.editedText ?? item.refinedText ?? ''),
    [suggestions, setSuggestions] = useState<number | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let url = ''
    api.history
      .detail(item.id)
      .then((d) => {
        if (!active) return
        setRecord(d.record)
        setCanDeleteCloud(d.canDeleteCloud === true)
        if (d.audio) {
          const bytes = new Uint8Array(d.audio)
          const ogg = String.fromCharCode(...bytes.slice(0, 4)) === 'OggS'
          url = URL.createObjectURL(
            new Blob([bytes], { type: ogg ? 'audio/ogg' : 'audio/wav' }),
          )
          setAudio(url)
        }
      })
      .catch((e) => setError(errorMessage(e)))
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [item.id])
  const restore = async (version: 'raw' | 'processed') => {
    setBusy(true); setError('')
    try {
      const next = await api.history.restoreVersion(item.id, version)
      setRecord(next); setText(next.editedText ?? next.refinedText ?? ''); setSuggestions(null); onChange()
      notify(version === 'raw' ? '已恢复识别原文' : '已恢复整理稿')
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const retry = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api.history.retry(item.id)
      setRecord(r)
      setText(r.editedText ?? r.refinedText ?? '')
      setSuggestions(null)
      onChange()
      notify('已重新识别')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="口述详情" onClose={onClose}>
      <div className="dialog-body">
        <div className="history-meta">
          <span>{record.focusedAppName || 'OpenType'}</span>
          <span>{durationLabel(record.duration)}</span>
        </div>
        {typeof parseMeta(record.modeMeta).skill_name === 'string' && <p className="muted">本次 Skill：{parseMeta(record.modeMeta).skill_name}。重新识别使用该 Skill 当前保存的指令。</p>}
        {audio ? (
          <audio controls src={audio} aria-label="播放录音" />
        ) : (
          <p className="muted">此记录没有可用的本地录音。</p>
        )}
        {parseMeta(record.modeMeta).text_version && <p className="muted">已恢复{parseMeta(record.modeMeta).text_version === 'raw' ? '识别原文' : '整理稿'}。此操作只修改历史文字，可复制后使用。</p>}
        <label className="field">
          整理后的文字
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
          />
        </label>
        {parseMeta(record.modeMeta).raw_text && (
          <details>
            <summary>查看识别原文</summary>
            <p className="original-text">
              {parseMeta(record.modeMeta).raw_text}
            </p>
          </details>
        )}
        {(error || parseMeta(record.debugInfo).detail) && (
          <p className="inline-error" role="alert">
            {error || errorMessage(parseMeta(record.debugInfo).detail)}
          </p>
        )}
        {suggestions !== null && <p className="muted" role="status">{suggestions > 0
          ? `发现 ${suggestions} 条纠词建议，请到词典页审核；尚未加入词典。`
          : '修改已保存，没有新的纠词建议。'}</p>}
        <div className="dialog-actions">
          <Menu label="更多操作" items={[
            ...(typeof parseMeta(record.modeMeta).raw_text === 'string' && parseMeta(record.modeMeta).raw_text.trim() ? [{ label: '恢复识别原文', disabled: busy, onSelect: () => void restore('raw') }] : []),
            ...(record.editedText !== null && record.refinedText ? [{ label: '恢复整理稿', disabled: busy, onSelect: () => void restore('processed') }] : []),
            { label: busy ? '识别中…' : '重新识别', disabled: busy || !audio, onSelect: retry },
            { label: '导出录音', disabled: !audio, onSelect: () => void api.history.exportAudio(item.id).then((r) => { if (!r.success && !r.canceled) notify('无法导出录音') }).catch((e) => notify(errorMessage(e))) },
            { label: '删除记录', danger: true, onSelect: () => setConfirm(true) },
          ]} />
          <span className="dialog-actions-spacer" />
          <button
            onClick={() => void api.copy(text).then(() => notify('已复制'))}
          >
            复制
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void api.history
                .edit(item.id, text)
                .then((result) => {
                  setSuggestions(result.candidates)
                  setRecord(r => ({ ...r, editedText: text }))
                  notify('修改已保存')
                  onChange()
                })
                .catch((e) => setError(errorMessage(e)))
            }
          >
            保存修改
          </button>
        </div>
        {confirm && <div className="danger-zone">
          {confirm ? (
            <>
              <div>
                <p>删除本机记录及录音，无法恢复。</p>
                {canDeleteCloud ? <label>
                  <input type="checkbox" checked={deleteCloud} onChange={e => setDeleteCloud(e.target.checked)} />
                  同时删除云端及其他同步设备上的这条记录
                </label> : <p>如有云端副本，需登录原账号并同步后再选择删除。</p>}
                {deleteCloud && <p>删除任务会保存在本机，联网并开启此账号的同步后执行。导出文件与系统备份不受影响。</p>}
              </div>
              <button
                className="danger"
                onClick={() =>
                  void window.opentype.history
                    .remove(item.id, deleteCloud)
                    .then(() => {
                      onChange()
                      onClose()
                      notify(deleteCloud ? '本机记录已删除，云端删除已加入同步队列' : '本机记录已删除')
                    })
                    .catch((e) => {
                      if (String(e).includes('audio_cleanup_pending')) {
                        onChange()
                        onClose()
                        notify(errorMessage(e))
                      } else setError(errorMessage(e))
                    })
                }
              >
                确认删除
              </button>
              <button onClick={() => setConfirm(false)}>取消</button>
            </>
          ) : null}
        </div>}
      </div>
    </Modal>
  )
}
