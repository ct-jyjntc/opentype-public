// 渲染层 IPC 桥接层。
//
// 渲染层是本项目的前端产物（frontend/renderer/），它的通道名在构建期
// 就固化成字符串（window.ipcRenderer.invoke('store:use', ...) 等）。
// 桥接层负责把这些通道映射到主进程服务，而不是反过来改渲染层的调用。
//
// 设计原则：只做「协议翻译」，业务逻辑复用已有服务。
// 例如 db:history-list 内部调 HistoryRepo，而不是重写一遍查询。

import { ipcMain, app, shell, clipboard, nativeImage, systemPreferences, nativeTheme } from 'electron'

import { toFrontendSyncUiStatus } from './frontend-shape'
import { desktopUpdater } from './updater'

export interface BridgeContext {
  /** 通用键值存储（store:use） */
  store: {
    get: (store: string, key: string) => unknown
    set: (store: string, key: string, value: unknown) => void
    getAll: (store: string) => Record<string, unknown>
    delete: (store: string, key: string) => void
  }
  /**
   * 本地数据库操作。
   *
   * 返回形状逐字段对齐前端产物（已从混淆代码中实测确认），
   * 前端不会迁就我们的结构，多一层或少一层包装都会让它静默失效。
   */
  db: {
    /** (offset, limit) -> { data, hasMore } */
    historyList: (offset: number, limit: number) => Promise<{ data: unknown[]; hasMore: boolean }>
    /** (id) -> { success, history }；history 内 mode_meta/client_metadata 为对象、audio_metadata 为字符串 */
    historyGet: (id: string) => Promise<{ success: boolean; history?: unknown }>
    historyUpsert: (record: Record<string, unknown>) => Promise<{ success: boolean }>
    /** 参数是单个 id 字符串，不是数组 */
    historyDelete: (id: string) => Promise<{ success: boolean }>
    historyDeleteByDuration: (seconds: number) => Promise<{ success: boolean }>
    /** 无参 -> { success, data }，data 是单个记录对象 */
    historyLatest: () => Promise<{ success: boolean; data?: unknown }>
    /** 无参 -> { success, id } */
    historyLatestId: () => Promise<{ success: boolean; id?: string }>
    /** 无参 -> { reason }，用于失败归因 */
    historyLatestIdForErrorTracking: () => Promise<{ reason?: string }>
    /** 更新记录的上下文元数据 */
    updateClientMetadata: (id: string, metadata: unknown) => Promise<void>
    /** 更新记录的模式元数据 */
    updateModeMeta: (id: string, patch: unknown) => Promise<void>
    /** 返回裸字符串，前端直接当 HTTP header 用 */
    deviceId: () => string
    /** ({ id, audioBuffer, mimeType, fileSuffix }) */
    saveAudio: (params: { id: string; audioBuffer: ArrayBuffer; mimeType?: string; fileSuffix?: string }) => Promise<unknown>
    /** ({ audioId }) -> { outputArrayBuffer }；前端不解构 success，只取 buffer */
    getAudio: (params: { audioId: string }) => Promise<{ outputArrayBuffer?: ArrayBuffer }>
  }
  /** 语音流程 */
  audio: {
    voiceFlow: (params: Record<string, unknown>) => Promise<unknown>
    /** 删除录音临时文件 */
    cleanAudioFile: (audioId: string) => Promise<void>
    abort: (abortId: string) => void
    /** (arrayBuffer) -> { success, outputArrayBuffer } */
    compressOpus: (data: ArrayBuffer) => Promise<{ success: boolean; outputArrayBuffer?: Uint8Array; error?: string }>
    /** 无参 -> { success, devices: { inputDevices: [...] } } */
    devices: () => { success: boolean; devices: { inputDevices: unknown[] } }
    /** -> { success, isMuted } */
    isMuted: () => { success: boolean; isMuted: boolean }
    mute: () => void
    unmute: () => void
  }
  /**
   * 分块编码会话。
   *
   * 前端边录边编码以压低长录音的内存峰值，三段式：start → encode×N → end。
   * 每段都必须回 { success }，否则前端会判定编码失败并走降级路径。
   */
  chunkSession: {
    start: (params: { audioId: string; sampleRate?: number; channels?: number }) => { success: boolean }
    encode: (params: { audioId: string; arrayBuffer: ArrayBuffer; filename?: string }) =>
      Promise<{ success: boolean; outputArrayBuffer?: Uint8Array; duration?: number }>
    end: (params: { audioId: string }) => { success: boolean }
  }
  /** 云端同步 */
  sync: {
    getStatus: () => Promise<unknown>
    getUiStatus: () => Promise<unknown>
    pushImmediately: () => Promise<unknown>
    setSyncEnabled: (enabled: boolean) => Promise<unknown>
    setCloudRetention: (days: number) => Promise<unknown>
    wipeCloud: () => Promise<unknown>
    confirmAlerts: (params: unknown) => Promise<unknown>
    refreshFromRemote: () => Promise<unknown>
  }
  /** 账号 */
  auth: {
    getCurrent: () => Promise<unknown>
    getAccessToken: () => Promise<string | null>
    logout: () => Promise<void>
    startAppLogin: (provider: string) => Promise<unknown>
  }
  /** 键盘监听 */
  keyboard: {
    start: () => number
    stop: () => void
    /** 设置页改完快捷键后调用：重读绑定再重启监听 */
    reload: () => void
    /** 向当前前台应用注入文本（onboarding 的快捷键测试用） */
    insertText: (text: string) => void
    insertRichText: (html: string, text: string) => void
    /** 键盘设备列表（检测是否外接键盘） */
    getDeviceList: () => unknown[]
  }
  /** 当前语言 */
  i18n: {
    getLanguage: () => string
    setLanguage: (lang: string) => void
  }
  /** 前台应用上下文 */
  context: {
    /** appPath → 图标 dataURL；拿不到返回 null（渲染层按 falsy 跳过缓存） */
    appIcon: (appPath?: string) => Promise<string | null>
  }
  /** 首次引导流程 */
  onboarding: {
    /** 完成引导：写 hasOnboarded 并重载主窗口到登录态对应页面 */
    complete: () => void
    /** 用户画像问卷（已答过则返回记录，渲染层据此跳过问卷步） */
    getUserProfileSurveys: () => { success: boolean; records: unknown[] }
    /** 提交画像问卷：尽力转发到服务端，失败静默成功 */
    submitUserProfileSurvey: (payload: unknown) => Promise<void>
  }
  /** 最后一次捕获的前台应用信息 */
  focusedContext: {
    /** { appInfo: { app_name, app_identifier, ... }, inputInfo: {...} }，渲染层按此键名读取 */
    getLastFocusedInfo: () => unknown
    /** audio-context:get-audio-context：录音前的上下文采集，reject 会中断整条语音流 */
    getAudioContext: () => unknown
    getFocusedAppInfo: () => unknown
    getFocusedInputInfo: () => unknown
    /** 裸字符串（渲染层直接 .trim()） */
    getSelectedText: () => string
    getFullContext: () => unknown
    /** 渲染层的轮询定时器设置，主进程侧无需实现，收下即可 */
    setLastFocusedInfoTimer: (interval: unknown) => void
  }
  /** 录音状态机的用户态开关（渲染层 recording-machine:set-disabled） */
  recording: {
    isUserDisabled: () => boolean
    /** 值变化时实现方负责广播 recording-machine:disabled-changed */
    setUserDisabled: (disabled: boolean) => void
  }
  /** 文件操作 */
  files: {
    saveRecordingLog: (log: string) => Promise<string | null>
    /**
     * 词典 CSV 导入：弹文件选择框 → 读文件 → 解析。
     * 返回 { success:true, fileName, words } 或 { success:false, fileName, reason }。
     */
    pickAndParseDictionaryCsv: () => Promise<unknown>
    /** ({ audioData, defaultFileName }) -> { success, canceled?, error? } */
    saveAudioWithDialog: (params: { audioData?: unknown; audioId?: string; defaultFileName?: string }) => Promise<unknown>
    /** ({ pngBytes, defaultFileName }) -> { success, canceled?, error? } */
    savePngWithDialog: (params: { pngBytes?: unknown; defaultFileName?: string }) => Promise<unknown>
  }
  /** 窗口控制 */
  windows: {
    openUrl: (url: string) => void
    isLidOpen: () => boolean
    openSettingsModal: (tab?: number, options?: unknown) => void
    openEntryWindow: () => void
    openBar: () => void
    closeSidebar: () => void
    closeInteractiveCard: () => void
    openInteractiveCard: (payload: unknown) => void
    getInteractiveCardPayload: () => unknown
    updateInteractiveCardBounds: (bounds: unknown) => void
    setHubWindowButtonVisibility: (visible: boolean) => void
    floatingBarSetExpanded: (expanded: boolean) => void
    floatingBarClick: () => void
    isOnboardingWindowVisible: () => boolean
    launchApplication: (bundleId: string) => boolean
    restart: () => void
  }
}

/** 已注册的通道名，用于去重与日志。 */
const registered = new Set<string>()

/**
 * 把内部结果包成前端期望的 { success, data }。
 *
 * 前端所有 sync-engine 通道都先判 success 再取 data，
 * 直接返回裸对象会被当成失败。null 一律视为失败。
 */
function okOrFail<T>(
  value: T | null | undefined,
  transform: (v: T) => unknown
): { success: boolean; data?: unknown; error?: string } {
  if (value === null || value === undefined) return { success: false, error: 'unavailable' }
  return { success: true, data: transform(value) }
}

/**
 * 同步状态字段名转换。
 *
 * 本地 SyncEngine 用的是自建后端协议（sync_enabled / cloud_retention），
 * 前端读的是它自己的命名（enabled / retention_seconds）。
 * 不转换的话前端拿到 undefined，开关状态显示不出来。
 */
function toFrontendSyncStatus(s: unknown): Record<string, unknown> {
  const v = (s ?? {}) as Record<string, unknown>
  return {
    enabled: v.sync_enabled ?? false,
    retention_seconds: v.cloud_retention ?? -1,
    // 企业策略与套餐限制由服务端下发，自建后端没有这两项，固定为 false
    passive_disabled_by_org: false,
    passive_disabled_by_tier: false,
    total: v.total ?? 0,
    latest_server_updated_at: v.latest_server_updated_at ?? 0,
    earliest_server_updated_at: v.earliest_server_updated_at ?? null,
    purge_before_at: v.purge_before_at ?? null
  }
}

/**
 * 注册一个兼容通道。
 *
 * 前端调用失败时 Electron 会打印 "No handler registered"，
 * 但不会告诉我们是哪个功能坏了。这里统一包一层错误处理，
 * 让失败可定位（记录通道名与参数）。
 */
function handle(channel: string, fn: (...args: any[]) => any): void {
  if (registered.has(channel)) return
  registered.add(channel)
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      console.error(`[compat] ${channel} 失败:`, (err as Error).message)
      throw err
    }
  })
}

export function registerRendererBridge(ctx: BridgeContext): { channels: string[] } {
  // MARK: - store:use（通用键值存储）
  //
  // 前端启动第一件事就是读 store，缺了它整个界面起不来。
  // 形态：{ action: 'get'|'set'|'get-all'|'delete', store, key, value }
  handle('store:use', (params: { action: string; store: string; key?: string; value?: unknown }) => {
    const { action, store, key, value } = params ?? {}
    switch (action) {
      case 'get': return ctx.store.get(store, key ?? '')
      case 'set': ctx.store.set(store, key ?? '', value); return undefined
      case 'get-all': return ctx.store.getAll(store)
      case 'delete': ctx.store.delete(store, key ?? ''); return undefined
      default: return undefined
    }
  })

  // MARK: - 账号
  handle('auth:get-current', () => ctx.auth.getCurrent())
  handle('auth:get-access-token', () => ctx.auth.getAccessToken())
  handle('auth:logout', () => ctx.auth.logout())
  handle('auth:start-app-login', (params: { provider?: string } | string) => {
    const provider = typeof params === 'string' ? params : (params?.provider ?? 'login')
    return ctx.auth.startAppLogin(provider)
  })
  // 前端还调这两个（我们走密码登录，返回未登录让前端展示登录页）
  handle('auth:is-logged-in', async () => Boolean(await ctx.auth.getCurrent()))
  handle('auth:login', () => ({ success: false, detail: 'use_password_login' }))

  // MARK: - 权限
  //
  // 形态：{ permission: 'accessibility'|'microphone', type: 'check'|'request' }
  //
  // 返回值必须是**裸布尔值**，不是 { granted } 对象。前端到处这样用：
  //   const ok = await invoke('permission:request', {...})
  //   if (ok) { ... }        // 真值判断
  //   await check() || await request()   // 短路
  // 返回对象会让每次检查都为真——对象恒 truthy——表现为「明明没授权却显示已授权」，
  // 权限引导永不出现，用户卡在无法录音的状态里还找不到原因。
  handle('permission:request', async (params: { permission: string; type: string }) => {
    const { permission, type } = params ?? {}
    if (permission === 'accessibility') {
      // request 模式会弹系统引导；check 模式只查询，不该打扰用户
      return systemPreferences.isTrustedAccessibilityClient(type === 'request')
    }
    if (permission === 'microphone') {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'granted') return true
      if (type === 'check') return false
      return await systemPreferences.askForMediaAccess('microphone')
    }
    return false
  })

  /**
   * 麦克风诊断。返回**字符串枚举**，不是对象。
   *
   * 前端拿它决定弹哪个引导：
   *   'systemPermissionRestricted'                   → 权限被系统限制
   *   'systemPermissionGrantedButDeviceUnavailable'  → 有权限但设备不可用
   *   'granted'                                      → 正常
   * 这两个值同时决定了「弹窗能否关闭」（closable=_0x378702），
   * 返回对象会让前端拿不到字符串，永远走默认分支。
   */
  handle('permission:diagnose-microphone', () => {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'restricted') return 'systemPermissionRestricted'
    if (status === 'denied') return 'systemPermissionRestricted'
    if (status === 'granted') {
      // 有权限但一个输入设备都没有：引导用户去检查设备而非权限
      const devices = ctx.audio.devices()
      const inputs = devices?.devices?.inputDevices ?? []
      return inputs.length === 0 ? 'systemPermissionGrantedButDeviceUnavailable' : 'granted'
    }
    return 'notDetermined'
  })
  handle('permission:check-with-child-process', () =>
    systemPreferences.isTrustedAccessibilityClient(false))
  handle('permission:reset-accessibility-permission', () => {
    // 重置需用户到系统设置操作，这里只返回当前状态
    return systemPreferences.isTrustedAccessibilityClient(false)
  })
  handle('permission:update-auto-launch', (enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
    return app.getLoginItemSettings().openAtLogin
  })
  handle('permission:update-show-app-in-dock', (show: boolean) => {
    if (process.platform === 'darwin' && app.dock) {
      if (show) void app.dock.show()
      else app.dock.hide()
    }
    return Boolean(show)
  })

  // MARK: - 设备
  handle('device:get-info', () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    deviceId: ctx.db.deviceId(),
    locale: app.getLocale()
  }))
  handle('device:is-lid-open', () => ctx.windows.isLidOpen())
  handle('audio:get-devices-async', () => ctx.audio.devices())
  handle('audio:is-muted', () => ctx.audio.isMuted())
  handle('audio:mute', () => { ctx.audio.mute() })
  handle('audio:unmute', () => { ctx.audio.unmute() })

  // MARK: - 数据库
  //
  // 参数与返回结构必须与前端产物逐字段对齐：前端是编译好的，
  // 不会迁就我们的形状。以下均已从混淆代码中实测确认：
  //   db:history-list(offset, limit) -> { data: [...], hasMore }
  //   db:history-get(id)             -> { success, history }
  //   db:history-latest              -> { success, data }
  //   db:history-delete(id)          -> { success }（单个 id，非数组）
  handle('db:history-list', (offset: number, limit: number) => ctx.db.historyList(offset, limit))
  handle('db:history-get', (id: string) => ctx.db.historyGet(String(id)))
  handle('db:history-upsert', (record: Record<string, unknown>) => ctx.db.historyUpsert(record))
  handle('db:history-delete', (id: string) => ctx.db.historyDelete(String(id)))
  handle('db:history-delete-by-duration', (seconds: number) =>
    ctx.db.historyDeleteByDuration(seconds))
  handle('db:history-latest', () => ctx.db.historyLatest())
  handle('db:history-latest-id', () => ctx.db.historyLatestId())
  handle('db:history-latest-id-for-error-tracking', () => ctx.db.historyLatestIdForErrorTracking())
  handle('db:get-device-id', () => ctx.db.deviceId())
  handle('db:history-save-audio', (params: { id: string; audioBuffer: ArrayBuffer; mimeType?: string; fileSuffix?: string }) =>
    ctx.db.saveAudio(params))
  /**
   * 更新记录的上下文元数据。
   *
   * 前端在录音过程中分批写入：先存基础记录，再补上下文与模式信息。
   * 不是 no-op —— 缺了它，同步到云端的记录会丢失上下文。
   */
  handle('db:history-upsert-client-metadata', (params: { id: string; metadata: unknown }) =>
    ctx.db.updateClientMetadata(params?.id, params?.metadata))

  /** 更新记录的模式元数据（delivery 结果、选中文本等）。 */
  handle('db:history-upsert-mode-meta', (params: { id: string; modeMetaPatch: unknown }) =>
    ctx.db.updateModeMeta(params?.id, params?.modeMetaPatch))

  // MARK: - 语音
  handle('audio:ai-voice-flow', (params: Record<string, unknown>) => ctx.audio.voiceFlow(params))
  handle('audio:abort-ai-voice-flow-request', (params: { abortId: string } | string) => {
    ctx.audio.abort(typeof params === 'string' ? params : String(params?.abortId ?? ''))
  })
  handle('audio:opus-compress-by-buffer', (params: { arrayBuffer: ArrayBuffer }) =>
    ctx.audio.compressOpus(params?.arrayBuffer))
  handle('audio:opus-compress-by-audio-id', (params: { audioId: string }) =>
    ctx.db.getAudio(params))
  /** 清理没有历史记录归属的临时文件；保留可播放、可重试的历史录音。 */
  handle('audio:clean-opus-audio-file', (params: { audioId: string }) =>
    ctx.audio.cleanAudioFile(params?.audioId))

  // MARK: - 分块编码会话
  handle('audio:opus-chunk-session-start', (params: { audioId: string; sampleRate?: number; channels?: number }) =>
    ctx.chunkSession.start(params ?? { audioId: '' }))
  handle('audio:opus-chunk-session-encode', (params: { audioId: string; arrayBuffer: ArrayBuffer; filename?: string }) =>
    ctx.chunkSession.encode(params))
  handle('audio:opus-chunk-session-end', (params: { audioId: string }) =>
    ctx.chunkSession.end(params ?? { audioId: '' }))

  // MARK: - 同步
  //
  // 全部通道统一返回 { success, data?, error? }。
  // 前端每条都先判 success 再取 data，直接给裸对象会让它认为调用失败——
  // 表现为同步状态面板永远空白、开关点不动。
  //
  // 另外 data 的字段名与本地 SyncEngine 不同，必须转换：
  //   本地 sync_enabled / cloud_retention  →  前端 enabled / retention_seconds
  handle('sync-engine:transcription-history:get-sync-status', async () =>
    okOrFail(await ctx.sync.getStatus(), toFrontendSyncStatus))
  handle('sync-engine:transcription-history:get-ui-status', async () =>
    okOrFail(await ctx.sync.getUiStatus(), toFrontendSyncUiStatus))
  handle('sync-engine:transcription-history:push-immediately', async () =>
    okOrFail(await ctx.sync.pushImmediately(), toFrontendSyncUiStatus))
  handle('sync-engine:transcription-history:set-sync-enabled', async (
    enabled: boolean,
    options?: { retention_seconds?: number; localHistoryDurationSeconds?: number }
  ) => {
    // 顺序有讲究：先设保留期再设开关。反过来的话，
    // 关闭同步时前端会带上本地保留时长，它不该被写进云端设置。
    if (enabled && typeof options?.retention_seconds === 'number') {
      await ctx.sync.setCloudRetention(options.retention_seconds)
    }
    // 返回值取最后一次调用的状态，保证前端拿到的 data 是最新的
    return okOrFail(await ctx.sync.setSyncEnabled(Boolean(enabled)), toFrontendSyncStatus)
  })
  handle('sync-engine:transcription-history:set-cloud-retention', async (days: number) =>
    okOrFail(await ctx.sync.setCloudRetention(Number(days)), toFrontendSyncStatus))
  handle('sync-engine:transcription-history:wipe-cloud-history', async () =>
    okOrFail(await ctx.sync.wipeCloud(), toFrontendSyncStatus))
  handle('sync-engine:transcription-history:confirm-alerts', async (params: unknown) =>
    okOrFail(await ctx.sync.confirmAlerts(params), toFrontendSyncStatus))
  handle('sync-engine:transcription-history:refresh-sync-status-from-remote', async () =>
    okOrFail(await ctx.sync.refreshFromRemote(), toFrontendSyncStatus))

  // MARK: - 键盘
  handle('keyboard:start-keyboard-listener', () => ctx.keyboard.start())
  handle('keyboard:stop-keyboard-listener', () => { ctx.keyboard.stop() })
  /**
   * 快捷键配置变更后重载监听。前端改完快捷键（写 app-settings.featureShortcutBindings）
   * 会调这个；必须重读绑定再重启监听，否则改完不生效。
   *
   * 参数是可选的额外监听键列表（如 [['Escape']]），原生层本就全量上报按键，
   * 不需要按列表过滤，这里接受但忽略。
   */
  handle('keyboard-input:reload-keyboard-shortcuts', (_extraKeys?: string[][]) => ctx.keyboard.reload())
  /** onboarding 快捷键测试用它做试写；其余 insert-text 通道是 input:inject-text。 */
  handle('keyboard-input:insert-text', (text: string) => { ctx.keyboard.insertText(String(text ?? '')) })
  handle('keyboard-input:insert-rich-text', (html: string, text: string) => {
    ctx.keyboard.insertRichText(String(html ?? ''), String(text ?? ''))
  })
  /** 检测是否外接键盘；渲染层按 isBuiltIn===false 判定。 */
  handle('keyboard-input:get-keyboard-device-list', () => ctx.keyboard.getDeviceList())

  // MARK: - 录音状态机
  //
  // 返回**裸布尔值**，不是 { disabled, reason } 对象。
  // 渲染层直接把它交给 setter（`_0x2ed1(值)`），对象恒 truthy 会被判成
  // 「始终处于禁用状态」，录音永久无法启动且没有任何报错。
  handle('recording-machine:get-disabled', () => ctx.recording.isUserDisabled() || !ctx.windows.isLidOpen())
  // 渲染层（DdHsgR7k.js 的 oe()）在 onboarding 各步骤挂载时禁用、卸载/完成时启用。
  // payload 是裸布尔；也可能带 { allowedFeatures } 对象（局部放行场景），
  // 对象形态按「未完全禁用」处理，避免误伤体验步骤。
  handle('recording-machine:set-disabled', (payload: unknown) => {
    ctx.recording.setUserDisabled(typeof payload === 'boolean' ? payload : false)
  })

  // MARK: - 系统上下文
  //
  // 裸字符串（如 'zh-CN'）。渲染层用它决定界面语言的初始值。
  handle('system-context:get-system-language', () => app.getLocale())

  // MARK: - 前台上下文
  //
  // 返回最后一次捕获的前台应用信息，用于「结合上下文润色」。
  // 形状契约：{ appInfo: { app_identifier, ... }, inputInfo }（渲染层按键名读取）。
  handle('focused-context:get-last-focused-info', () => ctx.focusedContext.getLastFocusedInfo())
  // 拼写注意：这个通道名里 app 与 info 之间是下划线，渲染层产物如此。
  handle('focused-context:get-focused-app_info', () => ctx.focusedContext.getFocusedAppInfo())
  handle('focused-context:get-focused-input-info', () => ctx.focusedContext.getFocusedInputInfo())
  // 裸字符串：渲染层对返回值直接 .trim()。
  handle('focused-context:get-selected-text', () => ctx.focusedContext.getSelectedText())
  handle('focused-context:get-full-context', () => ctx.focusedContext.getFullContext())
  // 渲染层提示系统的轮询控制，主进程不需要真定时器，收下返回 null。
  handle('focused-context:set-last-focused-info-timer', (interval: unknown) => ctx.focusedContext.setLastFocusedInfoTimer(interval))
  handle('focused-context:execute-last-focused-info-task', () => ctx.focusedContext.getLastFocusedInfo())

  // MARK: - 录音上下文
  //
  // 语音流开始前渲染层必调：invoke 未注册而 reject 会让整条语音流中断，
  // 浮窗显示「无法完成写作」。形状：{ active_application, text_insertion_point, context_metadata }。
  handle('audio-context:get-audio-context', () => ctx.focusedContext.getAudioContext())

  // MARK: - 剪贴板
  handle('clipboard:write-text', (text: string) => { clipboard.writeText(String(text ?? '')) })
  // 渲染层传的是 Uint8Array（分享卡片 PNG 字节），IPC 到主进程变为 Buffer；
  // 老版调用方可能传 dataURL 字符串，两种都接。
  handle('clipboard:write-image', (payload: unknown) => {
    try {
      let img
      if (typeof payload === 'string') {
        img = nativeImage.createFromDataURL(payload)
      } else if (payload instanceof Uint8Array || (payload && typeof payload === 'object' && 'buffer' in (payload as object))) {
        img = nativeImage.createFromBuffer(Buffer.from(payload as Uint8Array))
      }
      if (img && !img.isEmpty()) clipboard.writeImage(img)
      return Boolean(img && !img.isEmpty())
    } catch { return false }
  })

  // MARK: - 国际化
  handle('i18n:get-language', () => ctx.i18n.getLanguage())
  handle('i18n:set-language', (lang: string) => { ctx.i18n.setLanguage(String(lang)) })

  // MARK: - 外观
  handle('appearance:get-color-mode', () =>
    nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  handle('appearance:get-state', () => ({
    preference: 'system',
    colorMode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }))
  handle('appearance:set-preference', (pref: string) => {
    // 简化：system 跟随系统，其余暂不改（前端会在下次启动时读到）
    nativeTheme.themeSource = (pref === 'light' || pref === 'dark') ? pref : 'system'
    return { preference: pref, colorMode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }
  })

  // MARK: - 页面与窗口
  handle('page:open-url', (url: string) => { void shell.openExternal(String(url)) })
  handle('page:open-url-scheme', (url: string) => { void shell.openExternal(String(url)) })
  handle('page:launch-application', (bundleId: string) => ctx.windows.launchApplication(bundleId))
  /**
   * 打开设置弹窗。
   *
   * 实参是 (tab: number, options?: {...})。设置界面本身由前端渲染，
   * 主进程只需把窗口带到前台，并把 tab 与 options 转给渲染层——
   * 吞掉参数会让「从浮窗点翻译设置」跳到默认页而不是目标页。
   */
  handle('page:open-settings-modal', (tab?: number, options?: unknown) =>
    ctx.windows.openSettingsModal(tab, options))
  handle('page:open-entry-window', () => ctx.windows.openEntryWindow())
  // 通道名由前端产物固化，不能改名，否则前端调用落空
  handle('page:open-typeless-bar', () => ctx.windows.openBar())
  handle('page:close-sidebar', () => ctx.windows.closeSidebar())
  handle('page:close-interactive-card', () => ctx.windows.closeInteractiveCard())
  handle('page:open-interactive-card', (payload: unknown) => ctx.windows.openInteractiveCard(payload))
  handle('page:get-interactive-card-payload', () => ctx.windows.getInteractiveCardPayload())
  handle('page:update-interactive-card-bounds', (bounds: unknown) =>
    ctx.windows.updateInteractiveCardBounds(bounds))
  handle('page:set-hub-window-button-visibility', (visible: boolean) =>
    ctx.windows.setHubWindowButtonVisibility(Boolean(visible)))
  handle('page:floating-bar-set-expanded', (expanded: boolean) =>
    ctx.windows.floatingBarSetExpanded(Boolean(expanded)))
  handle('page:floating-bar-click', () => ctx.windows.floatingBarClick())
  handle('page:is-onboarding-window-visible', () => ctx.windows.isOnboardingWindowVisible())
  /**
   * 完成首次引导：写 hasOnboarded 并重载主窗口。
   * 渲染层的 markCompleted 会 await 这个调用，返回值不被使用。
   */
  handle('page:complete-onboarding', () => { ctx.onboarding.complete() })
  handle('page:set-debug-window-position', () => undefined)
  handle('page:floating-bar-update-positions', () => undefined)
  handle('page:floating-bar-set-always-on-top-for-windows', () => undefined)

  // MARK: - 应用
  handle('app:restart', () => { app.relaunch(); app.exit(0) })

  // MARK: - 更新
  //
  // Compatibility callers share the source renderer's actual updater state.
  handle('updater:check-for-update', async () => {
    const state = await desktopUpdater.check()
    if (state.phase === 'error' || state.phase === 'unavailable') throw new Error(state.message)
    return { version: state.phase === 'current' ? null : state.version ?? null, downloadedFile: null }
  })
  // Downloads remain explicit even for historical callers of the silent channel.
  handle('updater:check-update-and-download-silently', () => desktopUpdater.check())
  handle('updater:download-update', () => desktopUpdater.download())
  handle('updater:quit-and-install', () => desktopUpdater.install())

  // MARK: - 加密（自建后端不加密上下文，见 README 说明）
  handle('rsa:get-config', () => ({ enabled: false, publicKey: '' }))
  handle('rsa:set-config', () => undefined)
  handle('rsa:clear', () => undefined)
  handle('rsa:encrypt', (value: unknown) => ({ _encrypted: false, _type: 'json', _data: value }))

  // MARK: - 首次引导问卷
  //
  // 渲染层读 records.length>0 判断「已答过问卷」并跳过该步骤；
  // 提交结果不看返回值（失败也继续走），所以失败时静默成功。
  handle('onboarding:get-user-profile-surveys', () => ctx.onboarding.getUserProfileSurveys())
  handle('onboarding:submit-user-profile-survey', async (params: { payload?: unknown }) => {
    await ctx.onboarding.submitUserProfileSurvey(params?.payload ?? params)
    return { success: true }
  })

  // MARK: - 其他
  /** 保存录音诊断日志。用户主动导出时调用，写入 userData/logs。 */
  handle('file:save-recording-log', (params: { log: string }) =>
    ctx.files.saveRecordingLog(params?.log))
  handle('context:get-app-icon', (appPath?: string) => ctx.context.appIcon(appPath))
  handle('troubleshooting:get-system-info', () => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    appVersion: app.getVersion()
  }))
  handle('mixpanel:track-event', () => ({ success: true }))
  handle('enterprise-policy:updated', () => undefined)
  handle('release-notes:prefetch', () => undefined)
  handle('file:pick-and-parse-dictionary-csv', () => ctx.files.pickAndParseDictionaryCsv())
  handle('file:save-audio-with-dialog', (params: { audioData?: unknown; audioId?: string; defaultFileName?: string }) =>
    ctx.files.saveAudioWithDialog(params))
  handle('file:save-png-with-dialog', (params: { pngBytes?: unknown; defaultFileName?: string }) =>
    ctx.files.savePngWithDialog(params))
  // 渲染层无任何调用点（产物里搜不到 save-text），保持 null 不瞎实现
  handle('file:save-text-with-dialog', () => null)

  return { channels: [...registered] }
}
