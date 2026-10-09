import { useCallback, useEffect, useRef, useState } from 'react'
import { Empty, Icon, IconButton, Modal } from '../components/ui'
import { errorMessage, type DictionaryWord, type HistoryItem } from '../../shared/desktop'
import type { CorrectionCandidate, CorrectionList } from '../../shared/corrections'
import { HistoryDialog } from './history'
import { DictionarySyncPanel } from '../components/dictionary-sync'
const api = window.opentype.desktop.dictionary
export function DictionaryPage({ notify }: { notify: (s: string) => void }) {
  const scope=useRef('local'),loadId=useRef(0)
  const [words, setWords] = useState<DictionaryWord[]>([]),
    [proposals, setProposals] = useState<CorrectionList>({ items: [], total: 0, hasMore: false }),
    [reviewing, setReviewing] = useState<CorrectionCandidate | null>(null),
    [source, setSource] = useState<HistoryItem | null>(null),
    [query, setQuery] = useState(''),
    [editing, setEditing] = useState<DictionaryWord | 'new' | null>(null),
    [removing, setRemoving] = useState<DictionaryWord | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [importing, setImporting] = useState(false)
  const load = useCallback(async () => {
    const id=++loadId.current
    try {
      const [snapshot, candidates] = await Promise.all([api.snapshot(), window.opentype.desktop.corrections.list()])
      if(id!==loadId.current)return
      if(scope.current!==snapshot.scope){setEditing(null);setRemoving(null);setReviewing(null);scope.current=snapshot.scope}
      setWords(snapshot.words)
      setProposals(candidates)
      setError('')
    } catch (e) {
      if(id===loadId.current)setError(errorMessage(e))
    } finally {
      if(id===loadId.current)setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const offHistory = window.opentype.desktop.onHistory(() => void load())
    const offDictionary = api.onChanged(() => void load())
    return () => { offHistory(); offDictionary(); loadId.current++ }
  }, [load])
  const openSource = async (id: string) => {
    try { setSource((await window.opentype.desktop.history.detail(id)).record) }
    catch (e) { notify(errorMessage(e)) }
  }
  const filtered = words.filter((w) =>
    (w.term + ' ' + (w.pronunciation ?? ''))
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const dictionaryScope=scope.current
  return (
    <>
      <div className="page-heading">
        <h1>词典</h1>
        <button className="primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} />
          新词
        </button>
      </div>
      <DictionarySyncPanel notify={notify}/>
      <section className="correction-panel">
        <h2>待确认的纠词建议 <span className="count">{proposals.total}</span></h2>
        
        {!proposals.total && <p className="muted">暂时没有。你修改识别错的词后，会出现在这里。</p>}
        {proposals.items.map(c => <div className="correction-row" key={c.id}>
          <div><strong>{c.original} → {c.replacement}</strong><p className="muted">{c.sourceKind === 'input_edit' ? '输入框修改' : '历史修改'} · {c.appName || 'OpenType'} · {new Date(c.createdAt).toLocaleString('zh-CN')}</p></div>
          <div className="inline">
            <button onClick={() => void openSource(c.historyId)}>查看来源</button>
            <button onClick={() => void window.opentype.desktop.corrections.dismiss(c.id).then(load).catch(e => notify(errorMessage(e)))}>忽略</button>
            <button className="primary" onClick={() => setReviewing(c)}>审核词条</button>
          </div>
        </div>)}
        {proposals.hasMore && <button onClick={() => void window.opentype.desktop.corrections.list(proposals.items.length).then(r => setProposals(p => ({ ...r, items: [...p.items, ...r.items] }))).catch(e => notify(errorMessage(e)))}>加载更多建议</button>}
      </section>
      <div className="list-toolbar">
        <h2 className="list-title">全部词条 <span className="count">{words.length}</span></h2>
        <div className="inline">
          <button
            disabled={importing}
            onClick={async () => {
              setImporting(true)
              try {
                const r = await api.import(dictionaryScope)
                if (r.success) {
                  await load()
                  notify(`已导入 ${r.added} 个词汇`)
                } else if (r.reason !== 'canceled')
                  notify(r.reason || '导入失败')
              } catch (e) {
                notify(errorMessage(e))
              } finally {
                setImporting(false)
              }
            }}
          >
            <Icon name="download" size={16} />
            {importing ? '导入中…' : '导入 CSV'}
          </button>
          <label className="search">
            <Icon name="search" size={16} />
            <input
              aria-label="搜索词汇"
              placeholder="搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-panel">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      )}
      {words.length > 200 && <p className="muted">整理时只参考最近的 200 个词。</p>}
      {!filtered.length ? (
        <Empty
          icon="book"
          title={
            loading ? '正在加载…' : query ? '没有匹配的词汇' : '还没有词汇'
          }
          description="加入人名、品牌、术语，开启文字整理后会参考这些词条。"
        />
      ) : (
        <div className="dictionary-list">
          <div className="table-heading">
            <span>词汇</span>
            <span>常见误识别 / 读音提示</span>
            <span />
          </div>
          {filtered.map((w) => (
            <div className="word-row" key={w.id}>
              <div>
                <button className="text-button" onClick={() => setEditing(w)}>{w.term}</button>
                {w.sourceKind && <div className="word-source">{w.sourceHistoryId
                  ? <button className="text-button" onClick={() => void openSource(w.sourceHistoryId!)}>{w.sourceKind === 'input_edit' ? '输入框纠词' : '历史纠词'} · 查看来源</button>
                  : <span className="muted">{w.sourceKind === 'input_edit' ? '输入框纠词' : '历史纠词'} · 来源已删除</span>}</div>}
              </div>
              <span className="muted">{w.pronunciation || '—'}</span>
              <div className="inline">
                <button onClick={() => setEditing(w)}>编辑</button>
                <IconButton
                  name="trash"
                  label={`删除 ${w.term}`}
                  onClick={() => setRemoving(w)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <WordDialog
          word={editing}
          scope={dictionaryScope}
          onClose={() => setEditing(null)}
          saved={() => {
            void load()
            setEditing(null)
            notify('词汇已保存')
          }}
        />
      )}
      {reviewing && <WordDialog word={{ id: '', term: reviewing.replacement, pronunciation: reviewing.original, createdAt: null }}
        scope={dictionaryScope}
        candidate={reviewing} onClose={() => setReviewing(null)} saved={() => {}}
        accept={async (term, hint) => {
          const result = await window.opentype.desktop.corrections.accept(reviewing.id, term, hint,dictionaryScope)
          setReviewing(null); await load()
          notify(result.added ? '已加入词典' : '词典已有该词，保留原有词条')
        }} />}
      {source && <HistoryDialog key={source.id} item={source} onClose={() => setSource(null)} onChange={() => void load()} notify={notify} />}
      {removing && (
        <Modal title="删除词汇" onClose={() => setRemoving(null)}>
          <div className="dialog-body">
            <p>确认从个人词典删除“{removing.term}”？</p>
            {dictionaryScope!=='local'&&<p className="muted">其他同步设备上也会删除。</p>}
            <div className="dialog-actions">
              <button onClick={() => setRemoving(null)}>取消</button>
              <button
                className="danger"
                onClick={() =>
                  void api
                    .remove(removing.id,dictionaryScope,{term:removing.term,pronunciation:removing.pronunciation})
                    .then(() => {
                      setRemoving(null)
                      void load()
                      notify('词汇已删除')
                    })
                    .catch((e) => notify(errorMessage(e)))
                }
              >
                删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
function WordDialog({
  word,
  scope,
  onClose,
  saved,
  candidate,
  accept,
}: {
  word: DictionaryWord | 'new'
  scope:string
  onClose: () => void
  saved: () => void
  candidate?: CorrectionCandidate
  accept?: (term: string, hint: string) => Promise<void>
}) {
  const [term, setTerm] = useState(word === 'new' ? '' : word.term),
    [hint, setHint] = useState(
      word === 'new' ? '' : (word.pronunciation ?? ''),
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <Modal title={candidate ? '审核纠词建议' : word === 'new' ? '添加新词' : '编辑词汇'} onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            if (accept) await accept(term, hint)
            else { await api.save(term, hint, word === 'new' ? undefined : word.id,scope,word==='new'?undefined:{term:word.term,pronunciation:word.pronunciation}); saved() }
          } catch (e) {
            setError(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {candidate && <p>{candidate.sourceKind === 'input_edit' ? '输入框修改' : '历史修改'}：{candidate.original} → {candidate.replacement}。</p>}
        <label className="field">
          词汇
          <input
            autoFocus
            value={term}
            maxLength={100}
            placeholder="例如：OpenType"
            onChange={(e) => setTerm(e.target.value)}
          />
        </label>
        <label className="field">
          常见误识别或读音提示（可选）
          <input
            value={hint}
            maxLength={100}
            placeholder="例如：open type"
            onChange={(e) => setHint(e.target.value)}
          />
        </label>
        <p className="muted">开启文字整理时，词条和提示会随文字发送到整理服务。</p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !term.trim()}>
            {busy ? '保存中…' : candidate ? '确认加入词典' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
