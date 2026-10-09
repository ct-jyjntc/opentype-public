import { useEffect, useState } from 'react'
import type { KeyboardMonitorStatus, Preferences, SettingsTab } from '../../shared/desktop'
import { errorMessage } from '../../shared/desktop'
import { serviceEndpoint } from '../../shared/network-policy'
import { COMMON_WRITING_APPS, EXPRESSIONS, type ExpressionStyle, type WritingApp } from '../../shared/output-preferences'
import { Icon, Modal, Row, Toggle } from '../components/ui'
import { ShortcutRecorder } from '../components/shortcut-recorder'
import { shortcutLabel } from '../shortcut-label'
import { SpeechSettings } from '../speech-settings'
import { Markdown } from '../components/markdown'
import { SettingsBackup } from '../components/settings-backup'
import type { UpdateState } from '../../shared/updater'
import type { OutputAudioStatus } from '../../shared/output-audio'
const api = window.opentype
const tabs: [SettingsTab, string, string][] = [
  ['account', '账户', 'user'],
  ['general', '设置', 'settings'],
  ['speech', '听写模型', 'mic'],
  ['personal', '个性化', 'pen'],
  ['about', '关于', 'info'],
  ['help', '帮助', 'help'],
]
export function Settings({
  initial,
  onClose,
  notify,
}: {
  initial: SettingsTab
  onClose: () => void
  notify: (s: string) => void
}) {
  const [tab, setTab] = useState<SettingsTab>(initial === 'skills' ? 'general' : initial),
    [prefs, setPrefs] = useState<Preferences>(),
    [error, setError] = useState('')
  useEffect(() => {
    void api.desktop
      .snapshot()
      .then((v) => setPrefs(v.preferences))
      .catch((e) => setError(errorMessage(e)))
    return api.desktop.onPreferences(setPrefs)
  }, [])
  const save = async (p: Partial<Preferences>) => {
    try {
      setPrefs(await api.desktop.preferences(p))
      notify('设置已保存')
      return true
    } catch (e) {
      notify(errorMessage(e))
      return false
    }
  }
  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          {tabs.map(([id, label, icon]) => (
            <button
              className={tab === id ? 'active' : ''}
              key={id}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content" key={tab}>
          <h1>{tabs.find(([id]) => id === tab)?.[1]}</h1>
          {error && <p role="alert">{error}</p>}
          {tab === 'general' && prefs && (
            <General preferences={prefs} save={save} notify={notify} />
          )}
          {tab === 'speech' && <SpeechSettings embedded />}
          {tab === 'account' && <Account notify={notify} />}
          {tab === 'personal' && prefs && (
            <Personal preferences={prefs} save={save} />
          )}
          {tab === 'about' && <About />}
          {tab === 'help' && <Help />}
        </div>
      </div>
    </Modal>
  )
}
function General({
  preferences: p,
  save,
  notify,
}: {
  preferences: Preferences
  save: (p: Partial<Preferences>) => Promise<boolean>
  notify: (s: string) => void
}) {
  const [shortcut, setShortcut] = useState<{ action: string; index: number } | null>(null),
    [config, setConfig] = useState<any>(),
    [mics, setMics] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    let active = true
    void api.config.get().then(c=>{if(active)setConfig(c)})
    const refresh = () => void navigator.mediaDevices.enumerateDevices()
      .then(ds => {if(active)setMics(ds.filter(d=>d.kind==='audioinput'))}).catch(()=>{})
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    window.addEventListener('focus', refresh)
    return () => { active=false; navigator.mediaDevices.removeEventListener('devicechange',refresh); window.removeEventListener('focus',refresh) }
  }, [])
  const configSave = async (patch: Record<string, unknown>) => {
    try {
      setConfig(await api.config.set(patch))
      notify('设置已保存')
    } catch (e) {
      notify(errorMessage(e))
    }
  }
  return (
    <>
      <h3 className="section-heading">快捷键</h3>
      <KeyboardStatus notify={notify} />
      <Row title="录音方式" description="长按时，看到录音胶囊后开始说话；Esc 随时取消。">
        <select aria-label="录音方式" value={p.recordingActivation}
          onChange={e => void save({ recordingActivation: e.target.value as Preferences['recordingActivation'] })}>
          <option value="auto">短按或长按</option>
          <option value="toggle">按一下开始，再按一下结束</option>
          <option value="hold">按住说话，松开结束</option>
        </select>
      </Row>
      {[
        ['dictationMode', '语音输入', '可设置最多三组快捷键，使用相同的录音方式。'],
        ['translationMode', '翻译', '使用快捷键开始翻译。'],
        ['askAnythingMode', '随便问', '使用快捷键提问或编辑选中文字。'],
        ['pasteLastTranscript', '粘贴上一条听写', '将最近完成的听写粘贴到当前输入框，不重新识别；可移除全部绑定以关闭快捷键。'],
        ['selectionActions', '选中文字快捷操作', '选中文字后打开摘要、改写、翻译、校对或 Skill 面板；也可从托盘打开。'],
      ].map(([id, title, desc]) => (
        <Row key={id} title={title} description={desc}>
          <div className="shortcut-alternatives">
            {(p.featureShortcutBindings[id] ?? []).map((value,index)=><div className="shortcut-alternative" key={index}>
              <button className="shortcut" aria-label={`修改${title}快捷键 ${index+1}`} onClick={()=>setShortcut({action:id,index})}>{shortcutLabel(value)}</button>
              {((p.featureShortcutBindings[id]?.length??0)>1||['pasteLastTranscript','selectionActions'].includes(id)) && <button aria-label={`移除${title}快捷键 ${index+1}`} onClick={()=>void save({featureShortcutBindings:{...p.featureShortcutBindings,[id]:p.featureShortcutBindings[id].filter((_,i)=>i!==index)}})}>×</button>}
            </div>)}
            {(p.featureShortcutBindings[id]?.length??0)<3 && <button onClick={()=>setShortcut({action:id,index:p.featureShortcutBindings[id]?.length??0})}>添加快捷键</button>}
          </div>
        </Row>
      ))}
      <h3 className="section-heading">语言</h3>
      <Row title="识别语言" description="选择自动检测或指定说话的语言。">
        <select
          aria-label="识别语言"
          value={
            p.selectedLanguages.length === 1 ? p.selectedLanguages[0] : 'auto'
          }
          onChange={(e) =>
            void save({
              selectedLanguages:
                e.target.value === 'auto' ? [] : [e.target.value],
            })
          }
        >
          {[
            ['auto', '自动检测'],
            ['zh-CN', '普通话'],
            ['yue', '粤语'],
            ['en', 'English'],
            ['ja', '日本語'],
            ['ko', '한국어'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row title="翻译目标" description="语音翻译后输出的语言。">
        <select
          aria-label="翻译目标"
          value={config?.outputLanguage ?? 'en'}
          onChange={(e) => void configSave({ outputLanguage: e.target.value })}
        >
          {[
            ['en', 'English'],
            ['zh-CN', '简体中文'],
            ['zh-TW', '繁體中文'],
            ['ja', '日本語'],
            ['ko', '한국어'],
            ['fr', 'Français'],
            ['de', 'Deutsch'],
            ['es', 'Español'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <h3 className="section-heading">音频</h3>
      <Row
        title="麦克风"
        description="选择您首选的麦克风。未授权时设备名称可能不可见。"
      >
        <select
          aria-label="麦克风"
          value={config?.micDeviceId ?? 'default'}
          onChange={(e) => void configSave({ micDeviceId: e.target.value })}
        >
          <option value="default">跟随系统默认麦克风</option>
          {config?.micDeviceId && config.micDeviceId !== 'default' && !mics.some(m=>m.deviceId===config.micDeviceId) && <option value={config.micDeviceId}>已选设备未连接或尚未授权</option>}
          {mics
            .filter((m) => m.deviceId && m.deviceId !== 'default')
            .map((m, i) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || `麦克风 ${i + 1}`}
              </option>
            ))}
        </select>
      </Row>
      <Row title="录音提示音" description="麦克风打开后和停止后播放简短声音，取消也会提示。">
        <Toggle label="录音提示音" checked={p.interactionSounds} onChange={interactionSounds=>void save({interactionSounds})}/>
      </Row>
      <OutputAudioSettings value={p.outputAudio} save={save} />
      {p.outputAudio==='mute'&&p.interactionSounds&&<p className="muted">外放静音期间也听不到录音提示音，可选择降低音量。</p>}
      {([
        ['echoCancellation','回声消除','减少扬声器播放内容进入麦克风；具体支持取决于设备。'],
        ['noiseSuppression','环境降噪','使用系统音频处理减少背景噪声。'],
        ['autoGainControl','自动增益','自动调整输入音量；专业音频设备可关闭。'],
      ] as const).map(([key,title,description])=><Row title={title} description={description} key={key}>
        <Toggle label={title} checked={p.audioProcessing[key]} onChange={value=>void save({audioProcessing:{...p.audioProcessing,[key]:value}})}/>
      </Row>)}
      <p className="muted">音频处理设置在下一次录音生效。设备断开时自动停止并处理已经收到的内容。</p>
      <h3 className="section-heading">常规</h3>
      <Row title="浮窗位置" description="顶部和底部跟随当前输入窗口所在屏幕；拖动浮窗可记住位置。">
        <select aria-label="浮窗位置" value={p.floatingBar.placement} onChange={e=>void save({floatingBar:{...p.floatingBar,placement:e.target.value as Preferences['floatingBar']['placement']}})}>
          <option value="bottom">当前屏幕底部</option><option value="top">当前屏幕顶部</option><option value="remember">记住拖动位置</option>
        </select>
      </Row>
      <Row title="外观" description="选择明亮模式或黑暗模式。">
        <select
          aria-label="外观"
          value={p.appearance}
          onChange={(e) =>
            void save({
              appearance: e.target.value as Preferences['appearance'],
            })
          }
        >
          <option value="light">明亮</option>
          <option value="dark">黑暗</option>
          <option value="system">跟随系统</option>
        </select>
      </Row>
      <Row
        title="登录时启动应用"
        description="当您的计算机启动时自动打开 OpenType。"
      >
        <Toggle
          label="登录时启动应用"
          checked={p.launchAtLogin}
          onChange={(v) => void save({ launchAtLogin: v })}
        />
      </Row>
      {api.platform === 'darwin' && <Row
        title="在 Dock 中显示应用"
        description="在您的 Mac Dock 中显示 OpenType 以便快速访问。"
      >
        <Toggle
          label="在 Dock 中显示应用"
          checked={p.showInDock}
          onChange={(v) => void save({ showInDock: v })}
        />
      </Row>}
      <Row title="自动插入文字" description="完成听写后将文字输入原来的应用。">
        <Toggle
          label="自动插入文字"
          checked={config?.autoInject ?? true}
          onChange={(v) => void configSave({ autoInject: v })}
        />
      </Row>
      <SettingsBackup notify={notify} />
      {shortcut && <ShortcutRecorder
        current={p.featureShortcutBindings[shortcut.action]?.[shortcut.index] ?? ''}
        onClose={() => setShortcut(null)}
        onSave={value => { const next = [...(p.featureShortcutBindings[shortcut.action] ?? [])]; next[shortcut.index] = value; return save({ featureShortcutBindings: { ...p.featureShortcutBindings, [shortcut.action]: next } }) }}
      />}
    </>
  )
}
function OutputAudioSettings({ value, save }: { value: Preferences['outputAudio']; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  const [status, setStatus] = useState<OutputAudioStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const supported = status?.supported ?? (api.platform === 'darwin' || api.platform === 'win32')
  useEffect(() => {
    let mounted = true, live = false
    const unwatch = api.desktop.outputAudio.onState(next => { live = true; if (mounted) setStatus(next) })
    void api.desktop.outputAudio.status().then(next => { if (mounted && !live) setStatus(next) })
      .catch(e => { if (mounted) setError(errorMessage(e)) })
    return () => { mounted = false; unwatch() }
  }, [])
  const retry = async () => {
    setBusy(true); setError('')
    try { setStatus(await api.desktop.outputAudio.retryRecovery()) }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const labels: Record<OutputAudioStatus['phase'], string> = {
    idle: '没有待恢复的外放音量', starting: '正在调整外放音量',
    active: status?.detail === 'output_audio_changed' ? '保留您调整后的外放音量' : '录音音量设置已生效',
    restoring: '正在恢复外放音量', pending: '外放音量尚未完全恢复', error: '外放音量操作未完成',
  }
  return <>
    <Row title="录音时的外放音量" description={supported ? '减少播放声音干扰。停止录音后恢复；录音中手动调音量时优先保留您的调整。设置从下一次录音生效。' : '此平台暂不支持自动调节外放音量。'}>
      <select aria-label="录音时的外放音量" disabled={!supported} value={value} onChange={e => void save({ outputAudio: e.target.value as Preferences['outputAudio'] })}>
        <option value="off">保持原音量</option><option value="duck">降到原音量的 20%</option><option value="mute">静音外放</option>
      </select>
    </Row>
    {supported && <div aria-live="polite">
      {status && <p className="muted">{labels[status.phase]}{status.detail ? `：${errorMessage(status.detail)}` : ''}</p>}
      {status && ['pending', 'error'].includes(status.phase) && <>
        <button disabled={busy || status.recording} onClick={() => void retry()}>{busy ? '正在重试…' : '重试恢复音量'}</button>
        {status.recording && <p className="muted">结束录音后可重试恢复。</p>}
      </>}
      {api.platform === 'win32' && <p className="muted">调节系统默认播放和通信设备；单独指定到其他设备的应用不受此设置影响。</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </>
}

function KeyboardStatus({ notify }: { notify: (s: string) => void }) {
  const [status, setStatus] = useState<KeyboardMonitorStatus>()
  useEffect(() => {
    let alive = true
    const refresh = () => void api.desktop.keyboard.status()
      .then((value) => { if (alive) setStatus(value) })
      .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const ready = status?.active && status.callbackRegistered && status.inputMonitoring
  return <Row tone={!status ? undefined : ready ? 'ok' : 'warn'} title={ready ? '全局快捷键监听已就绪' : '全局快捷键尚未就绪'} description={
    !status ? '正在检查系统监听状态…' : !status.inputMonitoring
      ? api.platform === 'darwin' ? '请在系统设置 → 隐私与安全性 → 输入监控中启用 OpenType，返回后会自动重试。'
        : '当前系统桌面无法监听键盘；请解锁或退出系统安全提示后重新连接。'
      : ready ? '键盘监听正常。单独的修饰键会先判断是否组成其他快捷键。'
        : '系统监听已暂停，请点击重新连接。'
  }>
    <div className="inline">
      {status && !status.inputMonitoring && api.platform === 'darwin' && <button onClick={() => void api.desktop.openUrl(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
      ).catch((e) => notify(errorMessage(e)))}>输入监控权限</button>}
      <button onClick={() => void api.desktop.keyboard.restart().then((value) => {
        setStatus(value)
        notify(value.active ? '快捷键监听已重新连接' : api.platform === 'darwin' ? '监听尚未就绪，请检查输入监控权限' : '监听尚未就绪，请返回普通桌面后重试')
      }).catch((e) => notify(errorMessage(e)))}>重新连接</button>
    </div>
  </Row>
}

function Personal({
  preferences: p,
  save,
}: {
  preferences: Preferences
  save: (p: Partial<Preferences>) => Promise<boolean>
}) {
  const [style, setStyle] = useState(p.personalStyle)
  const [apps, setApps] = useState<WritingApp[]>(COMMON_WRITING_APPS)
  const [selectedApp, setSelectedApp] = useState(COMMON_WRITING_APPS[0].bundleId)
  const [expression, setExpression] = useState<ExpressionStyle>('casual')
  const [savingRule, setSavingRule] = useState(false)
  useEffect(() => { void api.desktop.writingApps().then(setApps).catch(() => {}) }, [])
  const updateRule = async () => {
    const app = apps.find(a => a.bundleId === selectedApp)
    if (!app) return
    setSavingRule(true)
    try { await save({ appExpressions: [...p.appExpressions.filter(a => a.bundleId !== app.bundleId), { ...app, expression }] }) }
    finally { setSavingRule(false) }
  }
  return (
    <>
      <Row title="从历史修改生成纠词建议" description="只在本机分析您主动保存的普通听写修改，确认后才加入词典。关闭后暂停生成新建议，已确认词条仍保留。">
        <Toggle label="从历史修改生成纠词建议" checked={p.learnFromEdits} onChange={v => void save({ learnFromEdits: v })} />
      </Row>
      <Row title="从输入框修改生成纠词建议" description="听写插入成功后，在原输入框检测最多一分钟。仅将本次插入内容的错词修改保存为本机待审核建议；不改历史、不自动入词典。检测时会读取原输入框核对范围，切换目标、修改范围外文字或开始新录音即停止。">
        <Toggle label="从输入框修改生成纠词建议" checked={p.learnFromInputEdits} onChange={v => void save({ learnFromInputEdits: v })} />
      </Row>
      <h2>听写输出格式</h2>
      <p className="muted">在本机处理，离线也生效。仅用于普通听写，不改变翻译和语音指令的结果。</p>
      <Row title="中文标点" description="将中文相邻的逗号、句号等改为全角；代码和地址尽量保持原样。">
        <select aria-label="中文标点" value={p.outputPreferences.punctuation}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, punctuation: e.target.value as 'preserve' | 'chinese' } })}>
          <option value="preserve">保持结果</option><option value="chinese">使用中文标点</option>
        </select>
      </Row>
      <Row title="中英文与数字间距" description="只调整中文与英文、数字交界的空格，保留换行。">
        <select aria-label="中英文与数字间距" value={p.outputPreferences.spacing}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, spacing: e.target.value as 'preserve' | 'space' | 'compact' } })}>
          <option value="preserve">保持结果</option><option value="space">加一个空格</option><option value="compact">不加空格</option>
        </select>
      </Row>
      <Row
        title="启用语气与写作偏好"
        description="需要开启 DeepSeek 文字整理并配置密钥；离线时保留原语气。"
      >
        <Toggle
          label="启用语气与写作偏好"
          checked={p.usePersonalStyle}
          onChange={(v) => void save({ usePersonalStyle: v })}
        />
      </Row>
      <Row title="默认表达方式" description="用于没有单独规则的应用；仅普通听写采用此偏好。">
        <select aria-label="默认表达方式" disabled={!p.usePersonalStyle} value={p.outputPreferences.expression}
          onChange={e => void save({ outputPreferences: { ...p.outputPreferences, expression: e.target.value as ExpressionStyle } })}>
          {EXPRESSIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
      </Row>
      <div className="app-expression-card">
        <h2>按应用选择表达方式</h2>
        <p className="muted">例如微信用自然口语，邮件用正式表达。按开始录音时的应用匹配；历史重试使用原目标应用和当前偏好。</p>
        <div className="app-expression-controls">
          <label className="field">应用<select aria-label="应用表达规则的应用" value={selectedApp} onChange={e => setSelectedApp(e.target.value)}>
            {apps.map(a => <option key={a.bundleId} value={a.bundleId}>{a.appName}</option>)}
          </select></label>
          <label className="field">表达方式<select aria-label="应用表达规则的语气" value={expression} onChange={e => setExpression(e.target.value as ExpressionStyle)}>
            {EXPRESSIONS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select></label>
          <button disabled={savingRule || (!p.appExpressions.some(a => a.bundleId === selectedApp) && p.appExpressions.length >= 50)} onClick={() => void updateRule()}>保存应用规则</button>
        </div>
        {p.appExpressions.length === 0 && <p className="muted">尚无单独规则，所有应用使用默认表达方式。</p>}
        {p.appExpressions.map(rule => <Row key={rule.bundleId} title={rule.appName} description={EXPRESSIONS.find(([key]) => key === rule.expression)?.[1]}>
          <button aria-label={`移除${rule.appName}的表达规则`} onClick={() => void save({ appExpressions: p.appExpressions.filter(a => a.bundleId !== rule.bundleId) })}>恢复默认</button>
        </Row>)}
        <p className="muted">其他应用完成一次听写后会出现在列表中。最多保存 50 条；浏览器按整个应用设置，不区分网站。</p>
      </div>
      <div className="personal-card">
        <Icon name="spark" size={32} />
        <h2>让文字更像您</h2>
        <p>填写额外的写作偏好。上方的表达方式优先决定语气，词典中的名称作为整理参考。</p>
        <label className="field">
          写作偏好
          <textarea
            rows={6}
            value={style}
            maxLength={1200}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="例如：表达简洁，使用中文标点；列举事项时分行，不添加表情。"
          />
        </label>
        <button
          className="primary"
          onClick={() => void save({ personalStyle: style })}
        >
          保存偏好
        </button>
        <p className="muted">
          识别原文保留在历史详情中。写作偏好由您明确设置；输入框纠词检测使用上方独立开关，仅生成待审核建议。
        </p>
      </div>
    </>
  )
}
function Account({ notify }: { notify: (s: string) => void }) {
  const [logged, setLogged] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sync, setSync] = useState<any>(null),
    [server, setServer] = useState(''),
    [savedServer, setSavedServer] = useState(''),
    [phase, setPhase] = useState('')
  const [pendingDeletions, setPendingDeletions] = useState(0)
  const [cloudExcluded, setCloudExcluded] = useState(0), [pendingCloudWipe, setPendingCloudWipe] = useState(false)
  const [confirmWipe, setConfirmWipe] = useState(false), [confirmRetention, setConfirmRetention] = useState<number | null>(null)
  const refreshLocal = async () => {
    const state = await api.sync.localStatus()
    setPendingDeletions(state.pendingDeletions)
    setCloudExcluded(state.cloudExcluded)
    setPendingCloudWipe(state.pendingCloudWipe)
  }
  const refreshSync = async () => {
    const status = await api.sync.status()
    setSync(status)
    await refreshLocal()
    if (!status) throw new Error('暂时无法连接同步服务，请稍后刷新状态')
  }
  let serverError = ''
  try { serviceEndpoint(savedServer) } catch (e) { serverError = errorMessage(e) }
  useEffect(() => {
    void api.sync.localStatus().then(s => { setPendingDeletions(s.pendingDeletions); setCloudExcluded(s.cloudExcluded ?? 0); setPendingCloudWipe(s.pendingCloudWipe === true) })
  }, [logged, phase])
  useEffect(() => {
    void api.auth.isLoggedIn().then(setLogged)
    void api.config.get().then((c) => { setServer(c.cloudBaseUrl); setSavedServer(c.cloudBaseUrl) })
    return api.sync.onState((s) => {
      setPhase(s.phase)
      if (s.phase === 'error') setError(errorMessage(s.detail))
    })
  }, [])
  useEffect(() => {
    if (logged)
      void api.sync
        .status()
        .then(async (status) => { setSync(status); await refreshLocal() })
        .catch((e) => setError(errorMessage(e)))
    else setSync(null)
  }, [logged])
  const syncSave = async (p: {
    sync_enabled?: boolean
    cloud_retention?: number
  }) => {
    setBusy(true);setError('')
    try {
      const r = await api.sync.updateSettings(p)
      if (r === null) {
        if (p.sync_enabled === false) {
          setSync((old: any) => ({ ...old, sync_enabled: false }))
          notify('已在本机关闭同步，联网后更新服务端')
          return
        }
        throw new Error('暂时无法连接同步服务')
      }
      setSync(r)
      await refreshLocal()
      notify(p.sync_enabled === false ? '云端同步已关闭' : '同步设置已保存')
    } catch (e) {
      setError(errorMessage(e))
    } finally { setBusy(false) }
  }
  return (
    <>
      <div className="account-card">
        <div className="avatar">
          <Icon name="user" size={28} />
        </div>
        <h2>{logged ? '已登录' : '本地账户'}</h2>
        <p>本地听写、历史和词典无需登录。登录后可分别选择同步历史和账号词典，词库同步在“词典”页开启。</p>
        {serverError && <p className="muted">{serverError}</p>}
      </div>
      {!logged ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError('')
            try {
              if (serverError) throw new Error(serverError)
              const r = await (register
                ? api.auth.register({ email, password })
                : api.auth.loginWithPassword({ email, password }))
              if (!r.success) throw new Error(r.detail)
              setLogged(true)
              setPassword('')
            } catch (e) {
              setError(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="field">
            邮箱
            <input
              type="email"
              value={email}
              required
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              value={password}
              minLength={register ? 8 : undefined}
              required
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={register ? 'new-password' : 'current-password'}
            />
          </label>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => {
                setRegister(!register)
                setError('')
              }}
            >
              {register ? '已有账户，去登录' : '注册账户'}
            </button>
            <button className="primary" disabled={busy || !!serverError}>
              {busy ? '处理中…' : register ? '注册并登录' : '登录'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <Row
            title="云端同步"
            description="打开后，历史文字将上传至已配置的 OpenType 服务。"
          >
            <Toggle
              label="云端同步"
              disabled={busy || phase === 'clearing_cloud'}
              checked={!!sync?.sync_enabled}
              onChange={(v) => void syncSave({ sync_enabled: v })}
            />
          </Row>
          <Row title="云端保留时间" description="按首次上传到服务器的时间计算，更新文字不会延长。到期仅移除云端副本，本机历史与录音保留。">
            <select
              aria-label="云端保留时间"
              value={sync?.cloud_retention ?? -1}
              disabled={busy || sync?.cloud_lifecycle_version !== 1}
              onChange={(e) => {
                const days = Number(e.target.value), old = sync?.cloud_retention ?? -1
                if (days > 0 && (old < 0 || days < old)) setConfirmRetention(days)
                else void syncSave({ cloud_retention: days })
              }}
            >
              <option value={-1}>永远</option>
              <option value={90}>90 天</option>
              <option value={30}>30 天</option>
              <option value={7}>7 天</option>
            </select>
          </Row>
          {sync && <p className="muted">云端现有 {sync.total ?? 0} 条历史。{sync.cloud_lifecycle_version !== 1 && '当前服务尚未支持可靠的云端清空与保留期，请先升级服务端。'}</p>}
          <div className="dialog-actions">
            <button disabled={busy || phase === 'clearing_cloud'} onClick={async () => {
              setBusy(true); setError('')
              try { await refreshSync() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
            }}>刷新同步状态</button>
            <button
              disabled={busy || !sync?.sync_enabled || phase === 'pushing' || phase === 'clearing_cloud'}
              onClick={() =>
                void api.sync
                  .pushNow()
                  .then(r => { if (r.detail) throw new Error(r.detail) })
                  .then(() => api.sync.pull())
                  .then(r => { if (r.detail) throw new Error(r.detail) })
                  .then(refreshSync)
                  .then(() => notify('同步请求已完成'))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              立即同步
            </button>
            <button className="danger" disabled={busy || phase === 'clearing_cloud' || sync?.cloud_lifecycle_version !== 1}
              onClick={() => setConfirmWipe(true)}>{pendingCloudWipe ? '确认上次清空结果' : '清空云端历史'}</button>
            <button
              disabled={busy}
              onClick={() =>
                void api.auth.logout().then(() => setLogged(false))
              }
            >
              退出登录
            </button>
          </div>
          {pendingDeletions > 0 && <p className="muted">待云端确认删除：{pendingDeletions} 条。联网并开启同步后自动尝试；失败后可点击“立即同步”重试。</p>}
          {cloudExcluded > 0 && <p className="muted">{cloudExcluded} 条记录因云端清空或到期仅保留在本机，不会再次自动上传。</p>}
        </>
      )}
      {confirmWipe && <Modal title={pendingCloudWipe ? '确认上次清空结果' : '清空云端历史'} onClose={() => { if (!busy) setConfirmWipe(false) }}>
        <div className="dialog-body">
          <p>{pendingCloudWipe ? '将查询并重试同一次清空请求，不会重复删除此后新上传的记录。' : '将移除当前账号的云端历史。本机文字、录音和已确认词典保留；云端副本无法恢复。'}</p>
          <p>各设备得知清空时已有的本机记录不会再自动上传，包括离线期间产生的记录。开启同步时，此后新录音可以继续上传。</p>
          <div className="dialog-actions"><button disabled={busy} onClick={() => setConfirmWipe(false)}>取消</button>
            <button className="danger" disabled={busy} onClick={async () => {
              setBusy(true);setError('')
              try {
                if (!await api.sync.wipeCloud()) throw new Error('清空结果尚未确认。请刷新状态，或稍后确认同一次清空请求。')
                setConfirmWipe(false); await refreshSync(); notify('云端清空已确认，本机历史与录音保留')
              } catch(e) {setError(errorMessage(e));setConfirmWipe(false)} finally {setBusy(false)}
            }}>{busy ? '正在确认…' : pendingCloudWipe ? '确认上次结果' : '确认清空云端'}</button></div>
        </div>
      </Modal>}
      {confirmRetention !== null && <Modal title="缩短云端保留时间" onClose={() => {if(!busy)setConfirmRetention(null)}}>
        <div className="dialog-body"><p>改为 {confirmRetention} 天后，超过保留期的云端副本会被移除，无法从云端恢复。本机历史和录音不受影响，已到期的记录不会重新上传。</p>
          <div className="dialog-actions"><button disabled={busy} onClick={()=>setConfirmRetention(null)}>取消</button>
            <button className="danger" disabled={busy} onClick={async()=>{await syncSave({cloud_retention:confirmRetention});setConfirmRetention(null)}}>确认更改</button></div>
        </div>
      </Modal>}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <details className="server-settings" open={!!serverError}>
        <summary>账号服务地址</summary>
        <label className="field">
          服务地址
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://your-server.example"
          />
        </label>
        <p className="muted">更改地址后需重新登录；本地识别模型不受影响。</p>
        <button
          onClick={() =>
            void api.config
              .set({ cloudBaseUrl: server })
              .then((c) => {
                setServer(c.cloudBaseUrl)
                setSavedServer(c.cloudBaseUrl)
                setError('')
                setLogged(false)
                notify('服务地址已保存')
              })
              .catch((e) => setError(errorMessage(e)))
          }
        >
          保存地址
        </button>
      </details>
    </>
  )
}
function About() {
  const [version, setVersion] = useState('')
  const [update,setUpdate] = useState<UpdateState>({phase:'idle',channel:'stable'}), [channel,setChannel] = useState<'stable'|'beta'>('stable'), [error,setError] = useState('')
  const busy = ['checking','downloading'].includes(update.phase)
  const change = async (action:()=>Promise<unknown>) => {
    setError(''); try { await action() } catch(e) { setError(errorMessage(e)) }
  }
  useEffect(() => {
    void api.desktop.snapshot().then((v) => setVersion(v.version))
    let alive = true, received = false
    const off = api.desktop.updater.onState(s=>{received=true;setUpdate(s);setChannel(s.channel)})
    void api.desktop.updater.get().then(s=>{if(alive&&!received){setUpdate(s);setChannel(s.channel)}}).catch(e=>{if(alive)setError(errorMessage(e))})
    return ()=>{alive=false;off()}
  }, [])
  const status = update.message || ({checking:'正在检查…',current:'已是最新版本',available:`发现新版本 ${update.version ?? ''}`,downloading:`正在下载 ${Math.round(update.percent??0)}%`,ready:'更新已下载',cancelled:'下载已取消',error:'更新失败',unavailable:'此版本不支持自动更新'} as Record<string,string>)[update.phase]
  const open = (url: string) => void api.desktop.openUrl(url)
  return (
    <div className="about-list">
      <div className="about-row">
        <div>
          <strong>版本</strong>
          <span>{version ? `v${version.replace(/^v/, '')}` : ''}{status ? ` · ${status}` : ''}</span>
        </div>
        {update.phase==='available' ? <button className="primary" disabled={channel!==update.channel} onClick={()=>void change(()=>api.desktop.updater.download())}>下载更新</button>
          : update.phase==='downloading' ? <button onClick={()=>void change(()=>api.desktop.updater.cancel())}>取消下载</button>
          : update.phase==='ready' ? <button className="primary" disabled={channel!==update.channel} onClick={()=>void change(()=>api.desktop.updater.install())}>重启并安装</button>
          : <button disabled={busy} onClick={()=>void change(()=>api.desktop.updater.check(channel))}>{update.phase==='checking'?'正在检查…':'检查更新'}</button>}
      </div>
      {update.phase==='downloading'&&<progress value={update.percent??0} max={100} aria-label="更新下载进度"/>}
      {update.phase==='ready'&&<p className="about-note">安装会关闭应用并重启，请先保存尚未保留的文字。</p>}
      {update.releaseNotes&&<details className="about-notes"><summary>版本说明 · {update.version}</summary><Markdown text={update.releaseNotes}/></details>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <div className="about-row">
        <strong>接收测试版</strong>
        <Toggle checked={channel==='beta'} disabled={busy} onChange={(v:boolean)=>{const c=v?'beta':'stable';setChannel(c);void change(()=>api.desktop.updater.check(c))}} label="接收测试版" />
      </div>
      <button className="about-row about-link" onClick={()=>open('https://github.com/ct-jyjntc/opentype-public/releases')}>
        <strong>发布页</strong><Icon name="external" size={18} />
      </button>
      <button className="about-row about-link" onClick={()=>open('https://github.com/ct-jyjntc/opentype-public')}>
        <strong>源代码</strong><Icon name="external" size={18} />
      </button>
    </div>
  )
}
function Help() {
  const groups: [string, [string, string][]][] = [
    ['开始使用', [
      ['如何开始听写？', '在目标应用点进输入框，使用设置中的听写快捷键开始和结束录音，Esc 取消。可在设置中选择短按切换或按住说话。'],
      ['需要哪些权限？', api.platform === 'darwin' ? '系统设置 → 隐私与安全性中开启麦克风、输入监控和辅助功能权限。输入监控用于全局热键，辅助功能用于文字插入。'
            : '在 Windows 隐私设置中允许桌面应用访问麦克风。请在普通桌面使用快捷键；目标应用以管理员权限运行时，可以手动复制听写结果。'],
      ['翻译与随便问如何使用？', '使用设置中的翻译或随便问快捷键，需要先配置 DeepSeek。选中文字后可要求改写或解释，回答先显示在卡片里；可编辑选区可点击“替换选中文字”，只读正文可复制回答。'],
    ]],
    ['隐私与离线', [
      ['离线可以使用吗？', '下载 SenseVoice Small 并关闭 DeepSeek 整理，即可在本机听写。录音不设最短或最长时长；说话时利用停顿提前识别，结束后补齐剩余内容并输出全文。'],
    ]],
    ['遇到问题', [
      ['失败后怎样找回内容？', '历史记录中打开这条口述，可播放、导出录音，查看原文，或重新识别。'],
    ]],
    ['开发者', [
      ['怎样修改这个界面？', '界面位于 src/renderer，使用 React、TypeScript 和 CSS；执行 npm run build 后启动即可。'],
    ]],
  ]
  return (
    <div className="help-content">
      {groups.map(([group, items]) => (
        <section className="help-group" key={group}>
          <h3 className="section-heading">{group}</h3>
          <div className="help-list">
            {items.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
