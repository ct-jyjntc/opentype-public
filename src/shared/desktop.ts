import type { SkillSettings } from './skills'
import type { FloatingBarSettings } from './floating-bar'
import type { AppExpression, OutputPreferences } from './output-preferences'
/** Data shared by the editable renderer and its explicit preload API. */
export type CaptureMode =
  | 'voice_transcript'
  | 'voice_command'
  | 'voice_translation'
export type SettingsTab =
  | 'account'
  | 'general'
  | 'speech'
  | 'personal'
  | 'skills'
  | 'about'
  | 'help'
export type RecordingActivation = 'auto' | 'toggle' | 'hold'
export interface AudioProcessing { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
export interface Preferences {
  floatingBar: FloatingBarSettings
  outputAudio: 'off' | 'duck' | 'mute'
  interactionSounds: boolean
  audioProcessing: AudioProcessing
  recordingActivation: RecordingActivation
  selectedLanguages: string[]
  featureShortcutBindings: Record<string, string[]>
  appearance: 'system' | 'light' | 'dark'
  launchAtLogin: boolean
  showInDock: boolean
  personalStyle: string
  usePersonalStyle: boolean
  learnFromEdits: boolean
  learnFromInputEdits: boolean
  outputPreferences: OutputPreferences
  appExpressions: AppExpression[]
  skills: SkillSettings
}
export interface HistoryItem {
  id: string
  status: string | null
  mode: CaptureMode
  refinedText: string | null
  editedText: string | null
  duration: number | null
  focusedAppName: string | null
  createdAt: string | null
  modeMeta: string | null
  debugInfo: string | null
}
export interface HistoryStats {
  count: number
  words: number
  seconds: number
  /** Original letters/numbers and matching audio duration from completed dictation. */
  dictationCharacters: number
  dictationSeconds: number
}
export interface HistoryDetail {
  canDeleteCloud?: boolean
  record: HistoryItem
  audio?: Uint8Array
}
export interface DictionaryWord {
  id: string
  term: string
  pronunciation: string | null
  createdAt: string | null
  sourceHistoryId?: string | null
  sourceKind?: 'history_edit' | 'input_edit' | null
}
export interface VoiceState {
  /** Which shortcut started this capture, so the capsule can show translation / ask-anything. */
  mode?: CaptureMode
  audioNotice?: string
  preview?: string
  completedSegments?: number
  skillName?: string
  stopGesture?: 'press' | 'release'
  phase:
    | 'idle'
    | 'preparing'
    | 'recording'
    | 'stopping'
    | 'encoding'
    | 'uploading'
    | 'transcribing'
    | 'refining'
    | 'injecting'
    | 'done'
    | 'error'
    | 'cancelled'
  audioId?: string
  text?: string
  detail?: string
  level?: number
}
export interface CardPayload {
  origin?: 'selection'
  selectionActions?: { source: string; busy: boolean; preview?: string; skills: Array<{ id: string; name: string }> }
  text: string
  title?: string
  audioId?: string
  id?: string
  canReplaceSelection?: boolean
  applyingSelection?: boolean
  targetAppName?: string
  contextNotice?: string
  detail?: string
}
export interface DesktopSnapshot {
  preferences: Preferences
  version: string
  platform: string
}
export function parseMeta(value: unknown): Record<string, any> {
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value)
  if (value && typeof value === 'object') return value as Record<string, any>
  try {
    return JSON.parse(String(value ?? '{}')) ?? {}
  } catch {
    return {}
  }
}
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const messages: Record<string, string> = {
    cancelled: '已取消',
    dictionary_scope_changed: '当前词典已切换，请重新打开这项操作',
    dictionary_word_changed: '此词条已被同步修改或删除，请关闭后重新查看',
    dictionary_sync_unsupported: '当前服务尚未支持词库同步，请先升级服务端',
    dictionary_sync_invalid_response: '词库同步响应无效，本机词典已保留',
    dictionary_sync_failed: '词库同步未完成，本机改动会保留并重试',
    dictionary_conflict_changed: '冲突内容已经变化，请关闭弹窗后重新查看并选择',
    dictionary_cursor_ahead: '服务器词库版本发生回退，可重新对齐后逐项处理差异',
    dictionary_sync_retry_required: '词库较大，本次同步已保存进度，将继续同步',
    output_audio_unavailable: '外放音量控制暂不可用，请检查输出设备和应用安装',
    output_audio_changed: '检测到手动音量调整，本次保留您的设置',
    output_audio_restore_pending: '输出设备暂不可用，重新连接后将尝试恢复音量',
    output_audio_storage_error: '音量恢复记录暂时无法读写，自动调节已暂停，请检查磁盘空间或文件权限',
    output_audio_busy: '另一个 OpenType 进程正在控制外放音量，结束后可重试恢复',
    output_audio_recording: '请先结束录音，再重试恢复外放音量',
    invalid_skills: 'Skill 设置无效，请检查名称、指令和应用范围',
    skill_not_available: '这个 Skill 已停用或删除，请重新选择',
    skill_mode_mismatch: '这个 Skill 不适用于当前模式，请修改适用模式',
    skill_unavailable: 'Skill 需要开启 DeepSeek 整理并配置密钥，识别原文已保留',
    skill_failed: 'Skill 处理失败，原文已保留，请稍后重试',
    skill_input_required: '请先输入需要处理的文字',
    empty_audio: '没有采集到音频，请检查麦克风后重试',
    apple_speech_platform: 'Apple 原生识别仅支持 macOS，请选择其他识别引擎',
    apple_speech_offline_unavailable: '当前设备或语言不支持 Apple 离线识别，请选择其他语言或 SenseVoice',
    apple_speech_model_missing: 'Apple 语言模型尚未准备，请在听写设置中准备模型',
    apple_speech_permission: '请在听写设置中授权语音识别；若已拒绝，请在系统设置的隐私与安全性中允许 OpenType',
    apple_speech_unavailable: 'Apple 识别暂不可用，请检查应用安装或选择 SenseVoice',
    apple_speech_install_failed: 'Apple 语言模型准备失败，请检查网络与系统存储后重试',
    apple_speech_failed: 'Apple 语音识别失败，请重试或选择 SenseVoice',
    apple_speech_timeout: 'Apple 语音识别响应超时，请重试',
    apple_speech_busy: 'Apple 语言模型正在准备，请完成后再听写',
    unsupported_language: 'SenseVoice Small 支持普通话、粤语、英语、日语和韩语，请修改识别语言',
    capture_failed: '无法使用麦克风，请检查设备与权限',
    microphone_permission: '麦克风权限未开启，请在系统设置中允许 OpenType 录音',
    microphone_missing: '找不到选择的麦克风，请连接设备或重新选择',
    microphone_busy: '无法打开麦克风，请检查是否被其他应用占用',
    microphone_disconnected: '麦克风已断开',
    microphone_disconnected_saved: '麦克风已断开，已停止录音并处理此前收到的内容',
    capture_flush_timeout: '麦克风停止超时，请重新录音',
    refine_unavailable: '文字整理服务尚未配置，原始文字已保留',
    refine_failed: '文字整理失败，原始文字已保留',
    audio_missing: '这条记录没有可用的本地录音',
    invalid_credentials: '邮箱或密码不正确',
    email_exists: '该邮箱已注册',
    password_too_short: '密码至少需要 8 位',
    invalid_auth_input: '账号信息格式不正确或过长，请检查后重试',
    challenge_required: '请先完成安全验证；若看不到验证区域，请更新 OpenType 后重试',
    challenge_expired: '安全验证已过期或已使用，请重新验证',
    challenge_invalid: '安全验证未通过，请重试',
    challenge_unavailable: '暂时无法连接安全验证服务，请稍后重试',
    use_password_login: '请在应用内的“设置 → 账户”完成登录',
    rate_limited: '操作过于频繁，请稍后重试',
    mail_not_configured: '邮件服务暂未开放，请使用邮箱和密码登录',
    mail_delivery_failed: '验证码邮件发送失败，请稍后重试',
    internal_server_error: '账号服务暂时不可用，请稍后重试',
    official_backend_managed: '账号服务由 OpenType 统一管理',
    invalid_email: '邮箱格式不正确',
    too_many_attempts: '尝试次数过多，请稍后重试',
    invalid_shortcut:
      '快捷键无效或重复，请使用 Fn、F1 或 Cmd+Shift+Space 等组合',
    empty_transcription: '没有识别到语音，请检查麦克风或重新录音',
    local_asr_busy: '本地模型正在处理另一条录音，请稍后重试',
    siliconflow_key_required: '请到听写设置填写 SiliconFlow API Key，或选择本地识别',
    siliconflow_invalid_key: 'SiliconFlow API Key 无效或已过期，请到听写设置更新',
    siliconflow_insufficient_balance: 'SiliconFlow 账户余额不足，请充值或选择本地识别',
    siliconflow_forbidden: 'SiliconFlow 拒绝了请求，请检查 API Key 和模型使用权限',
    siliconflow_rate_limited: 'SiliconFlow 请求过于频繁，请稍后重试或选择本地识别',
    siliconflow_audio_rejected: 'SiliconFlow 无法处理这段录音，请重新录音或选择本地识别',
    siliconflow_model_unavailable: 'SiliconFlow 暂时无法提供 SenseVoice Small，请稍后重试',
    siliconflow_unavailable: 'SiliconFlow 服务暂不可用，请稍后重试或选择本地识别',
    siliconflow_invalid_response: 'SiliconFlow 返回了无效的识别结果，请稍后重试',
    siliconflow_network_error: '无法连接 SiliconFlow，请检查网络或选择本地识别',
    siliconflow_timeout: 'SiliconFlow 识别超时，请稍后重试或选择本地识别',
    siliconflow_redirect_refused: 'SiliconFlow 返回了非预期的重定向，已停止发送凭据',
    record_deleted: '这条记录已删除，已停止处理',
    audio_cleanup_pending: '文字记录已删除，但录音文件暂时无法清理，应用会继续重试',
    audio_storage_busy: '请先结束当前录音或识别，再管理录音文件',
    audio_storage_unsafe_directory: '录音目录结构发生变化，请检查目录后重试',
    audio_storage_file_changed: '文件已变化或不存在，请重新扫描后核对',
    audio_storage_referenced: '文件已被历史记录使用，已保留，请重新扫描',
    audio_storage_conflict: '原位置已有其他文件，已保留回收站副本，请先处理冲突',
    audio_storage_review_expired: '扫描结果已过期，请重新扫描后操作',
    audio_storage_invalid_selection: '选择已失效，请重新扫描并选择文件',
    audio_storage_preview_large: '此文件较大，请找回到历史后播放或导出',
    history_cloud_account_mismatch: '此记录不属于当前服务器与账号，请重新登录原账号后操作',
    cloud_deletion_unsupported: '当前云端服务尚不支持按条删除；删除任务已保留，请升级服务后重试',
    cloud_deletion_rejected: '云端尚未确认全部删除，请在同步设置中重试',
    cloud_lifecycle_unsupported: '当前服务不支持可靠的云端清空与保留期，请先升级服务端',
    cloud_lifecycle_store_missing: '云端清理状态暂时无法保存，请更新客户端后重试',
    cloud_epoch_changed: '云端已清空，将先保留本机旧记录，再继续同步新录音',
    invalid_cloud_epoch: '云端返回了无效的清空状态，请稍后重试',
    invalid_sync_settings: '同步设置无效，请重新选择保留时间',
    cloud_not_configured: '账号服务暂时不可用，请稍后重试；本地听写无需登录',
    insecure_cloud_url: '服务地址需要 HTTPS，请修改相应的服务器地址；本机回环地址可用 HTTP',
    invalid_cloud_url: '云端服务器地址格式不正确',
    service_redirect_refused: '服务返回了重定向，请填写最终的 HTTPS 服务地址后重试',
    session_changed: '登录状态已改变，请重新操作',
    invalid_csv: 'CSV 格式不正确，请使用词汇、提示两列，每个词汇不超过 100 字',
    empty_term: '请输入词汇',
    duplicate_term: '这个词汇已经存在',
    model_not_ready: '模型尚未就绪，请到听写设置中准备或修复模型后重试',
    invalid_output_preferences: '输出偏好无效，请重新选择',
    invalid_app_expression: '应用表达规则无效、重复或超过 50 条，请检查后重试',
    correction_stale: '这条建议的来源已改变或已处理，请刷新后重试',
    history_version_missing: '这条记录没有可恢复的原文或整理稿',
    invalid_history_text: '修改内容无效或超过一百万字，请缩短后保存；原记录未改动',
    injection_permission: '缺少辅助功能权限，文字已保存，可复制后粘贴',
    injection_elevated_target: '目标应用以更高权限运行，无法自动输入；文字已保留，可手动粘贴',
    injection_clipboard_unavailable: '暂时无法完整保存和恢复剪贴板，文字未自动粘贴，可手动复制',
    injection_clipboard_changed: '剪贴板已被其他操作更新，已停止自动粘贴',
    injection_keys_held: '请先松开修饰键；文字已保留，可手动复制',
    injection_front_app_missing: '未找到前台应用，文字已保存',
    injection_app_changed: '已切换到其他应用，未粘贴；文字已保存',
    injection_focus_unavailable: '无法读取输入框焦点，文字已保存',
    injection_focus_pid_unavailable: '无法确认输入框所属应用，文字已保存',
    injection_focus_pid_mismatch: '焦点与前台应用不一致，文字已保存',
    injection_secure_target: '安全输入框不允许自动插入，文字已保存',
    injection_activation_failed: '无法激活原输入应用，文字已保存',
    injection_focus_pending: '正在恢复输入框焦点',
    injection_prepare_bridge_failed: '输入位置恢复失败，文字已保存',
    injection_ready_bridge_failed: '输入位置校验失败，文字已保存',
    injection_commit_bridge_failed: '文字发送状态未知，请核对输入框',
    injection_verify_bridge_failed: '无法确认文字是否插入，请核对输入框',
    injection_capture_bridge_failed: '输入位置采集失败，文字已保存',
    injection_target_unavailable: '无法恢复原输入位置，文字已保存，可复制后粘贴',
    injection_target_not_editable: '当前位置不是可确认的输入框，文字已保存，可复制后粘贴',
    injection_target_disabled: '原输入框已禁用，文字已保存，可复制后粘贴',
    injection_target_readonly: '当前位置是只读内容，文字已保存，可复制后粘贴',
    injection_target_value_not_settable: '此输入框未提供可编辑能力，文字已保存，可复制后粘贴',
    injection_target_value_unavailable: '无法确认原输入框内容，文字已保存，可复制后粘贴',
    injection_target_range_unavailable: '此输入框未提供光标位置，文字已保存，可复制后粘贴',
    injection_target_capacity: '输入位置记录已满，请重新开始听写；文字已保存',
    injection_focus_timeout: '原输入框未及时恢复焦点，文字已保存，可复制后粘贴',
    injection_target_closed: '原来的输入窗口或应用已关闭，文字已保存',
    injection_target_changed: '原输入框内容已改变，未覆盖新内容；文字已保存',
    injection_selection_changed: '无法恢复原选区，未插入文字；结果已保存',
    injection_failed: '文字尚未插入，已保存在历史记录中',
    injection_unverified: '已尝试发送文字，请核对输入框；无法自动确认结果',
    injection_cancelled_after_send: '取消时文字已经发送，请核对输入框',
    injection_history_save_failed: '文字已发送，但未能保存交付状态，请核对输入框',
    injection_already_sent: '这条文字已尝试发送，请先核对输入框，避免重复粘贴',
    answer_selection_expired: '原选区已失效，请重新选中文字并提问；回答仍可复制',
    answer_selection_replaced: '已替换原选区',
    answer_selection_save_failed: '尚未替换原文，交付状态未能保存；回答仍可复制',
    answer_record_changed: '回答的历史记录已改变或删除，未替换原文；回答仍可复制',
    answer_recording_busy: '正在录音或处理，请结束后再点击替换；回答仍可复制',
  }
  return (
    Object.entries(messages).find(([key]) => raw.includes(key))?.[1] ??
    (raw || '操作失败，请重试')
  )
}

export interface KeyboardMonitorStatus {
  platform?: string
  inputMonitoring: boolean
  requested: boolean
  active: boolean
  callbackRegistered: boolean
  eventCount: number
  lastEventAt: number
  recoveryCount: number
}

export interface ShortcutCaptureState {
  id: string
  active: boolean
  shortcut?: string
  reason?: 'closed' | 'blurred' | 'cancelled'
}
