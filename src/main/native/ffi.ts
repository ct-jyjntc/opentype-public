// 原生库 FFI 桥接层。
// 设计原则：所有 dylib 通过 koffi 以 C ABI 加载，函数签名在此集中声明，
// 上层服务只消费语义化方法，不接触指针与内存释放细节。

import koffi from 'koffi'
import { randomUUID } from 'node:crypto'
import { recordInputDiagnostic } from '../services/input-diagnostics'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { app, screen, systemPreferences } from 'electron'
import { createKeyboardMonitor } from './keyboard'
import type { InputDeliveryNative, InputSnapshot } from '../services/input-delivery'
import type { InputObservationNative } from '../services/input-corrections'
export type { KeyEvent } from './keyboard'

/** 原生库根目录：开发态在 native/，打包后随 resources 一起分发。 */
function nativeRoot(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'lib'),
    path.join(app.getAppPath(), 'native'),
    path.join(process.cwd(), 'native')
  ]
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir
  }
  throw new Error('native helper directory not found')
}

const loaded = new Map<string, koffi.IKoffiLib>()
function loadLib(group: string, fileName: string): koffi.IKoffiLib {
  const full = process.platform === 'win32' ? path.join(nativeRoot(), 'windows', 'build', 'OpenTypeNative.dll')
    : path.join(nativeRoot(), group, 'build', fileName)
  const previous = loaded.get(full)
  if (previous) return previous
  if (!existsSync(full)) {
    throw new Error(`native library missing: ${full}. 请先执行 npm run native`)
  }
  const library = koffi.load(full); loaded.set(full, library); return library
}

// MARK: - 类型别名
const str = 'str'
const int = 'int'
const bool = 'bool'
const voidPtr = koffi.pointer('void')

// MARK: - InputHelper：文本注入
const inputLib = loadLib('input-helper', 'libInputHelper.dylib')
const _freeStringInput = inputLib.func('freeString', 'void', [voidPtr])
const _insertText = inputLib.func('insertText', int, [str])
const _insertRichText = inputLib.func('insertRichText', int, [str, str])
const _deleteBackward = inputLib.func('deleteBackward', int, [int])
const _getSelectedText = inputLib.func('getSelectedText', voidPtr, [])
const _getCurrentInputState = inputLib.func('getCurrentInputState', voidPtr, [])
const _captureInputTarget = inputLib.func('captureInputTarget', voidPtr, [])
const _captureCommandTarget = inputLib.func('captureCommandTarget', voidPtr, [])
const _prepareInputTarget = inputLib.func('prepareInputTarget', voidPtr, [str])
const _inputTargetDiagnostics = process.platform === 'darwin' ? inputLib.func('inputTargetDiagnostics', voidPtr, [str]) : undefined
const traces = new Map<string, string>()
const _inputTargetReady = inputLib.func('inputTargetReady', voidPtr, [str])
const _commitInputTarget = inputLib.func('commitInputTarget', voidPtr, [str, str])
const _verifyInputTarget = inputLib.func('verifyInputTarget', voidPtr, [str])
const _releaseInputTarget = inputLib.func('releaseInputTarget', 'void', [str])
const _beginInputObservation = inputLib.func('beginInputObservation', voidPtr, [str, str])
const _readInputObservation = inputLib.func('readInputObservation', voidPtr, [str])
const _restoreNativeClipboard = process.platform === 'win32' ? inputLib.func('restoreNativeClipboard', 'void', []) : undefined

/** 把 C 返回的 char* 读成字符串并立刻释放，避免跨运行时内存泄漏。 */
function consume(ptr: unknown): string | null {
  if (!ptr) return null
  const value = koffi.decode(ptr, 'char', -1) as string
  _freeStringInput(ptr)
  return value || null
}

export const InputHelper = {
  restoreClipboard() { _restoreNativeClipboard?.() },
  captureTarget(allowReadOnlySelection = false, traceId = randomUUID()): InputSnapshot {
    recordInputDiagnostic(traceId, 'capture-start')
    try {
      const raw = consume(allowReadOnlySelection ? _captureCommandTarget() : _captureInputTarget())
      if (!raw) throw new Error('empty_bridge_result')
      const target = JSON.parse(raw) as InputSnapshot & { diagnostics?: Record<string, unknown> }
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('invalid_bridge_result')
      target.traceId = traceId
      if (target.token) traces.set(target.token, traceId)
      recordInputDiagnostic(traceId, 'capture-result', { ...target.diagnostics, reason: target.reason, ok: !!target.token })
      if (process.platform === 'win32' && target.windowBounds) target.windowBounds = screen.screenToDipRect(null, target.windowBounds)
      return target
    }
    catch { recordInputDiagnostic(traceId, 'capture-bridge', { reason: 'injection_capture_bridge_failed' }); return { traceId, appName: '', bundleId: '', pid: 0, reason: 'injection_capture_bridge_failed' } }
  },
  releaseTarget(token: string) { _releaseInputTarget(token); traces.delete(token) },
  /** 在光标处插入纯文本，返回 0 表示成功。 */
  insertText(text: string): number {
    return _insertText(text) as number
  },

  /** 插入富文本，保留 HTML 格式。 */
  insertRichText(html: string, text: string): number {
    return _insertRichText(html, text) as number
  },

  /** 向前删除 n 个字符，用于撤销注入。 */
  deleteBackward(count: number): number {
    return _deleteBackward(count) as number
  },

  /** 读取当前选中文本（模拟 Cmd+C）。 */
  getSelectedText(): string | null {
    return consume(_getSelectedText())
  },

  /** 当前前台应用的输入状态。 */
  getCurrentInputState(): { bundleId: string; appName: string; pid: number } | null {
    const raw = consume(_getCurrentInputState())
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
}

export const InputObservation: InputObservationNative = {
  begin: (token, text) => JSON.parse(consume(_beginInputObservation(token, text)) ?? '{}'),
  read: token => JSON.parse(consume(_readInputObservation(token)) ?? '{}'),
  release: token => { _releaseInputTarget(token); traces.delete(token) },
}

function deliveryJSON(value: unknown) {
  const raw = consume(value)
  if (!raw) throw new Error('injection_bridge_error')
  const response = JSON.parse(raw)
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('injection_bridge_error')
  return response
}
function asyncDelivery(fn: ReturnType<koffi.IKoffiLib['func']>, ...args: string[]): Promise<any> {
  return new Promise((resolve, reject) => fn.async(...args, (error: Error | null, pointer: unknown) => {
    if (error) reject(error)
    else {
      try { resolve(deliveryJSON(pointer)) }
      catch (decodeError) { reject(decodeError) }
    }
  }))
}
function deliveryDiagnostic(token: string, stage: string, result: Record<string, unknown>) {
  const traceId = traces.get(token) ?? 'untracked'
  let metadata: Record<string, unknown> = {}
  try { if (_inputTargetDiagnostics) metadata = deliveryJSON(_inputTargetDiagnostics(token)) } catch { /* bridge metadata unavailable */ }
  recordInputDiagnostic(traceId, stage, { ...metadata, ...result })
}
export const InputDelivery: InputDeliveryNative = {
  prepare: async token => { deliveryDiagnostic(token, 'prepare-start', {}); try { const result = await asyncDelivery(_prepareInputTarget, token); deliveryDiagnostic(token, 'prepare-result', result); return result } catch (error) { deliveryDiagnostic(token, 'prepare-bridge', { reason: 'injection_prepare_bridge_failed' }); throw new Error('injection_prepare_bridge_failed') } },
  ready: token => { try { const result = deliveryJSON(_inputTargetReady(token)); deliveryDiagnostic(token, 'ready', result); return result } catch (error) { deliveryDiagnostic(token, 'ready-bridge', { reason: 'injection_ready_bridge_failed' }); throw new Error('injection_ready_bridge_failed') } },
  commit: async (token, text) => { deliveryDiagnostic(token, 'commit-start', {}); try { const result = await asyncDelivery(_commitInputTarget, token, text); deliveryDiagnostic(token, 'commit-result', result); return result } catch (error) { deliveryDiagnostic(token, 'commit-bridge', { reason: 'injection_commit_bridge_failed' }); throw error } },
  verify: token => { try { const result = deliveryJSON(_verifyInputTarget(token)); deliveryDiagnostic(token, 'verify', result); return result } catch (error) { deliveryDiagnostic(token, 'verify-bridge', { reason: 'injection_verify_bridge_failed' }); throw error } },
}

// MARK: - KeyboardHelper：全局热键
const keyboardLib = loadLib('keyboard-helper', 'libKeyboardHelper.dylib')
const _freeStringKeyboard = keyboardLib.func('freeString', 'void', [voidPtr])
const _getKeyboardDeviceList = keyboardLib.func('getKeyboardDeviceList', voidPtr, [])
const _transformKeyNamesToKeyCodes = keyboardLib.func('transformKeyNamesToKeyCodes', voidPtr, [str])

export const KeyboardHelper = {
  ...createKeyboardMonitor(keyboardLib),

  getDeviceList(): Array<{ name: string; vendorId: string; productId: string }> {
    const raw = consume2(_getKeyboardDeviceList())
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  },

  keyNamesToCodes(names: string[]): number[] {
    const raw = consume2(_transformKeyNamesToKeyCodes(names.join(',')))
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  }
}

function consume2(ptr: unknown): string | null {
  if (!ptr) return null
  const value = koffi.decode(ptr, 'char', -1) as string
  _freeStringKeyboard(ptr)
  return value || null
}

// MARK: - ContextHelper：前台上下文
const contextLib = loadLib('context-helper', 'libContextHelper.dylib')
const _freeStringContext = contextLib.func('freeString', 'void', [voidPtr])
const _getFocusedInputInfo = contextLib.func('getFocusedInputInfo', voidPtr, [])
const _getFocusedAppInfo = contextLib.func('getFocusedAppInfo', voidPtr, [])
const _isBrowserApp = contextLib.func('isBrowserApp', bool, [str])

export interface FocusedContext {
  success: boolean
  reason?: string
  appName?: string
  bundleId?: string
  pid?: number
  role?: string
  focusedValue?: string
  selectedText?: string
  surroundingText?: string
  web?: { url?: string; title?: string }
}

export const ContextHelper = {
  getFocusedInputInfo(): FocusedContext {
    const raw = consume3(_getFocusedInputInfo())
    if (!raw) return { success: false, reason: 'empty_response' }
    try { return JSON.parse(raw) } catch { return { success: false, reason: 'parse_failed' } }
  },

  getFocusedAppInfo(): { appName: string; bundleId: string; pid: number } | null {
    const raw = consume3(_getFocusedAppInfo())
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  },

  isBrowserApp(bundleId: string): boolean {
    return _isBrowserApp(bundleId) as boolean
  }
}

function consume3(ptr: unknown): string | null {
  if (!ptr) return null
  const value = koffi.decode(ptr, 'char', -1) as string
  _freeStringContext(ptr)
  return value || null
}

// MARK: - UtilHelper：系统工具
const utilLib = loadLib('util-helper', 'libUtilHelper.dylib')
const _freeStringUtil = utilLib.func('freeString', 'void', [voidPtr])
const _checkAccessibilityPermission = utilLib.func('checkAccessibilityPermission', int, [])
const _checkMicrophonePermission = utilLib.func('checkMicrophonePermission', int, [])
const _getAudioDevicesJSON = utilLib.func('getAudioDevicesJSON', voidPtr, [])
const _isAudioMuted = utilLib.func('isAudioMuted', int, [])
const _muteAudio = utilLib.func('muteAudio', int, [])
const _unmuteAudio = utilLib.func('unmuteAudio', int, [])
const _deviceIsLidOpen = utilLib.func('deviceIsLidOpen', int, [])
const _getDeviceId = utilLib.func('getDeviceId', voidPtr, [])
const _launchApplicationByName = utilLib.func('launchApplicationByName', bool, [str])

export interface AudioDevice {
  deviceId: string
  label: string
  groupId: string
  channels: number
  index: number
  isDefault: boolean
}

export const UtilHelper = {
  /** 触发辅助功能授权引导并返回当前状态。 */
  checkAccessibilityPermission(): boolean {
    return (_checkAccessibilityPermission() as number) === 1
  },

  /** 0=未决定 1=受限 2=拒绝 3=已授权 */
  checkMicrophonePermission(): number {
    if (process.platform === 'win32') {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      return status === 'granted' ? 3 : status === 'denied' ? 2 : status === 'restricted' ? 1 : 0
    }
    return _checkMicrophonePermission() as number
  },

  getAudioDevices(): AudioDevice[] {
    const raw = consume4(_getAudioDevicesJSON())
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  },

  isAudioMuted(): boolean {
    return (_isAudioMuted() as number) === 1
  },

  muteAudio(): void { _muteAudio() },
  unmuteAudio(): void { _unmuteAudio() },

  /** 合盖时录音会失败，需要提前拦截。 */
  isLidOpen(): boolean {
    return (_deviceIsLidOpen() as number) === 1
  },

  getDeviceId(): string {
    return consume4(_getDeviceId()) ?? 'unknown'
  },

  launchApplication(nameOrBundleId: string): boolean {
    return _launchApplicationByName(nameOrBundleId) as boolean
  }
}

function consume4(ptr: unknown): string | null {
  if (!ptr) return null
  const value = koffi.decode(ptr, 'char', -1) as string
  _freeStringUtil(ptr)
  return value || null
}
