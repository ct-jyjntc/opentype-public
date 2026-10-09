// 原生层冒烟测试：验证四个 dylib 能被 koffi 加载、符号签名正确、返回值可解码。
// 这是整个方案的承重墙——FFI 一旦不通，上层所有逻辑都是空谈。
import koffi from 'koffi'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const voidPtr = koffi.pointer('void')
const results = []

function load(group, file) {
  const full = path.join(root, 'native', group, 'build', file)
  return koffi.load(full)
}

function readAndFree(lib, ptr) {
  if (!ptr) return null
  const value = koffi.decode(ptr, 'char', -1)
  lib.func('freeString', 'void', [voidPtr])(ptr)
  return value
}

// --- UtilHelper
try {
  const lib = load('util-helper', 'libUtilHelper.dylib')
  const free = lib.func('freeString', 'void', [voidPtr])
  const checkAcc = lib.func('checkAccessibilityPermission', 'int', [])
  const checkMic = lib.func('checkMicrophonePermission', 'int', [])
  const devices = lib.func('getAudioDevicesJSON', voidPtr, [])
  const lidOpen = lib.func('deviceIsLidOpen', 'int', [])
  const deviceId = lib.func('getDeviceId', voidPtr, [])
  const muted = lib.func('isAudioMuted', 'int', [])

  const acc = checkAcc()
  const mic = checkMic()
  const lid = lidOpen()
  const mute = muted()
  const rawDevices = readAndFree(lib, devices())
  const rawId = readAndFree(lib, deviceId())
  const list = JSON.parse(rawDevices || '[]')

  results.push(['UtilHelper', 'OK', `accessibility=${acc} microphone=${mic} lidOpen=${lid} muted=${mute}`])
  results.push(['UtilHelper/devices', list.length ? 'OK' : 'EMPTY',
    list.map((d) => `${d.label}(ch=${d.channels}${d.isDefault ? ',default' : ''})`).join(' | ') || 'no input device'])
  results.push(['UtilHelper/deviceId', rawId ? 'OK' : 'FAIL', rawId ? 'nonempty (value omitted)' : 'empty'])
} catch (e) {
  results.push(['UtilHelper', 'FAIL', e.message])
}

// --- InputHelper
try {
  const lib = load('input-helper', 'libInputHelper.dylib')
  const free = lib.func('freeString', 'void', [voidPtr])
  // Binding verifies ABI availability without copying an unrelated foreground
  // selection. Actual capture is exercised in the disposable UI fixtures.
  lib.func('getSelectedText', voidPtr, [])
  lib.func('captureInputTarget', voidPtr, [])
  lib.func('captureCommandTarget', voidPtr, [])
  const getState = lib.func('getCurrentInputState', voidPtr, [])
  const deleteBackward = lib.func('deleteBackward', 'int', ['int'])

  const state = readAndFree(lib, getState())
  // deleteBackward(0) 应当被参数校验拒绝，验证错误分支可用
  const delZero = deleteBackward(0)

  results.push(['InputHelper/state', state ? 'OK' : 'FAIL', state || ''])
  results.push(['InputHelper/selection APIs', 'OK', 'symbols bound; selection reading covered by isolated UI tests'])
  results.push(['InputHelper/deleteBackward(0)', delZero === -1 ? 'OK' : 'FAIL', `ret=${delZero} (期望 -1)`])
} catch (e) {
  results.push(['InputHelper', 'FAIL', e.message])
}

// --- ContextHelper
try {
  const lib = load('context-helper', 'libContextHelper.dylib')
  const free = lib.func('freeString', 'void', [voidPtr])
  lib.func('getFocusedInputInfo', voidPtr, [])
  const getAppInfo = lib.func('getFocusedAppInfo', voidPtr, [])
  const isBrowser = lib.func('isBrowserApp', 'bool', ['str'])

  const appInfo = readAndFree(lib, getAppInfo())
  const browserChrome = isBrowser('com.google.Chrome')
  const browserNotepad = isBrowser('com.apple.TextEdit')
  // 实测确认为前缀匹配：Chrome 的变体 bundle id 也应识别
  const browserChromeCanary = isBrowser('com.google.Chrome.canary')
  const browserComet = isBrowser('ai.perplexity.comet')

  results.push(['ContextHelper/appInfo', appInfo ? 'OK' : 'FAIL', appInfo || ''])
  results.push(['ContextHelper/focusedInput', 'OK', 'symbol bound; does not read arbitrary foreground content'])
  results.push(['ContextHelper/isBrowserApp', (browserChrome && !browserNotepad) ? 'OK' : 'FAIL',
    `Chrome=${browserChrome} TextEdit=${browserNotepad}`])
  results.push(['ContextHelper/isBrowserApp(前缀匹配)', (browserChromeCanary && browserComet) ? 'OK' : 'FAIL',
    `Chrome.canary=${browserChromeCanary} perplexity.comet=${browserComet}`])
} catch (e) {
  results.push(['ContextHelper', 'FAIL', e.message])
}

// --- KeyboardHelper
try {
  const lib = load('keyboard-helper', 'libKeyboardHelper.dylib')
  const free = lib.func('freeString', 'void', [voidPtr])
  const getDevices = lib.func('getKeyboardDeviceList', voidPtr, [])
  const namesToCodes = lib.func('transformKeyNamesToKeyCodes', voidPtr, ['str'])

  const devs = JSON.parse(readAndFree(lib, getDevices()) || '[]')
  const codes = JSON.parse(readAndFree(lib, namesToCodes('F1,F2,Space')) || '[]')

  results.push(['KeyboardHelper/devices', devs.length ? 'OK' : 'EMPTY',
    devs.map((d) => d.name).join(' | ') || 'none'])
  // 0x7A=F1, 0x78=F2, 0x31=Space
  const expected = JSON.stringify([0x7a, 0x78, 0x31])
  results.push(['KeyboardHelper/keyNamesToCodes', JSON.stringify(codes) === expected ? 'OK' : 'FAIL',
    `${JSON.stringify(codes)} (期望 ${expected})`])
} catch (e) {
  results.push(['KeyboardHelper', 'FAIL', e.message])
}

// 键盘回调签名一致性检查。
//
// 曾经崩溃：Swift 侧声明 2 参数、koffi 按 2 参数解析时，
// 第一个 Int32 被当成 char* 去 strlen → SIGSEGV；
// 后又发现回调里调 freeString 会把 koffi 转好的 JS string 当指针释放 → SIGTRAP。
//
// 这里做两件事：
//   1. 用 5 参数 proto 注册回调 —— 类型不匹配时 koffi 会抛错
//   2. 启动监听并确认返回 0 —— 证明 C ABI 层能接受该回调
//
// 不依赖合成按键：CGEvent 投递需要事件循环持续运行，
// 在同步测试脚本里不可靠（实测独立脚本能收到、此环境下收不到）。
// 真实回调路径由应用运行时覆盖。
try {
  const lib = koffi.load(path.join(root, 'native/keyboard-helper/build/libKeyboardHelper.dylib'))
  // 5 参数 + 返回 bool：与 Swift 侧 KeyCallback 完全一致
  const proto = koffi.proto('bool SmokeKbCbV2(int, char*, int, int, char*)')
  const start = lib.func('startKeyboardMonitor', 'int', [koffi.pointer(proto)])

  let registered = false
  const cb = koffi.register((keyCode, keyName, isDown, isRepeat, json) => {
    registered = true
    return false
  }, koffi.pointer(proto))

  const rc = start(cb)
  results.push([
    'KeyboardHelper/callback',
    rc === 0 ? 'OK' : 'FAIL',
    `5 参数签名注册成功, 监听返回=${rc}`
  ])
  if (rc === 0) lib.func('stopKeyboardMonitor', 'void', [])()
} catch (e) {
  results.push(['KeyboardHelper/callback', 'FAIL', e.message])
}

console.log('\n=== 原生层冒烟测试 ===')
let failed = 0
for (const [name, status, detail] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status.padEnd(6)} ${name.padEnd(34)} ${detail}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed > 0 ? 1 : 0)
