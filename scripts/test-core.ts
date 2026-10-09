// 核心算法测试：热键状态机 + WAV 编码。
// 这两处是纯逻辑，不需要 Electron 运行时，可以直接用 Node 验证。
// 它们错了整个产品就是废的——状态机错会导致录音停不下来，编码错会让服务端收到垃圾音频。

import { parseShortcutString, HotkeyStateMachine, type HotkeyEvent, type HotkeyBinding } from '../src/main/services/hotkey.ts'
import { encodeWav, float32ToInt16 } from '../src/main/services/pcm.ts'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  OK   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`)
  }
}

// MARK: - 热键状态机
console.log('\n=== 热键状态机 ===')

function keyEvent(type: 'keyDown' | 'keyUp', key: string, modifiers: string[] = [], isRepeat = false) {
  return { type, key, modifiers, isRepeat, keyCode: 0, timestamp: 0 }
}

const PTT: HotkeyBinding = { key: 'Space', modifiers: ['Command', 'Shift'], pushToTalk: true }
const TOGGLE: HotkeyBinding = { key: 'F1', modifiers: [], pushToTalk: false }

// 场景 1：按住说话 -> 松开结束
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([PTT])

  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift']))
  check('push-to-talk: 按下触发 start', events.map((e) => e.action), ['start'])
  check('push-to-talk: 录音中', sm.recording, true)

  sm.handle(keyEvent('keyUp', 'Space', ['Command', 'Shift']))
  check('push-to-talk: 松开触发 stop', events.map((e) => e.action), ['start', 'stop'])
  check('push-to-talk: 已停止', sm.recording, false)
}

// 场景 2：长按自动重复不应重复触发
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([PTT])
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift']))
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift'], true))
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift'], true))
  check('长按重复: 只触发一次 start', events.map((e) => e.action), ['start'])
}

// 场景 3：修饰键不精确匹配则不触发
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([PTT])
  sm.handle(keyEvent('keyDown', 'Space', ['Command']))               // 少按 Shift
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift', 'Option']))  // 多按 Option
  check('修饰键不匹配: 不触发', events.length, 0)
}

// 场景 4：切换模式（按一下开始，再按一下结束）
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([TOGGLE])
  sm.handle(keyEvent('keyDown', 'F1'))
  sm.handle(keyEvent('keyUp', 'F1'))
  check('toggle: 松开不结束', events.map((e) => e.action), ['start'])
  // 越过防抖窗口
  await sleep(220)
  sm.handle(keyEvent('keyDown', 'F1'))
  check('toggle: 再按结束', events.map((e) => e.action), ['start', 'stop'])
}

// 场景 5：防抖窗口内的连击被忽略
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([TOGGLE])
  sm.handle(keyEvent('keyDown', 'F1'))
  sm.handle(keyEvent('keyUp', 'F1'))
  sm.handle(keyEvent('keyDown', 'F1'))  // 立刻再按，应被防抖拦截
  check('防抖: 连击只触发一次', events.map((e) => e.action), ['start'])
}

// 场景 6：Esc 取消
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([PTT])
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift']))
  sm.handleCancel()
  check('取消: 派发 cancel', events.map((e) => e.action), ['start', 'cancel'])
  check('取消: 状态已重置', sm.recording, false)
  // 取消后再松开不应再派发 stop
  sm.handle(keyEvent('keyUp', 'Space', ['Command', 'Shift']))
  check('取消后松开: 不重复派发', events.map((e) => e.action), ['start', 'cancel'])
}

// 场景 7：多绑定共存，各自独立
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine((e) => events.push(e))
  sm.setBindings([PTT, TOGGLE])
  sm.handle(keyEvent('keyDown', 'F1'))
  check('多绑定: F1 命中 toggle', events.map((e) => e.action), ['start'])
  sm.handle(keyEvent('keyUp', 'F1'))
  sm.handle(keyEvent('keyDown', 'Space', ['Command', 'Shift']))  // 录音中，应被忽略
  check('多绑定: 录音中不重复启动', events.map((e) => e.action), ['start'])
}

// Physical Fn sequences include the modifier's own event before the chord's main key.
for (const chord of ['Space','LeftShift']) {
 const events:HotkeyEvent[]=[]
 const sm=new HotkeyStateMachine(e=>events.push(e))
 sm.setBindings([{key:'Fn',modifiers:[],pushToTalk:false},{key:'Space',modifiers:['Fn'],pushToTalk:false},{key:'Shift',modifiers:['Fn'],pushToTalk:false}])
 sm.handle({...keyEvent('keyDown','Fn'),keyCode:0x3f})
 check('Fn waits for possible chord',events.length,0)
 sm.handle({...keyEvent('keyDown',chord,['Fn']),keyCode:chord==='Space'?0x31:0x38})
 sm.handle({...keyEvent('keyUp','Fn'),keyCode:0x3f})
 check('Physical Fn+'+chord+' selects one correct mode',events.map(e=>e.binding.key),[chord==='Space'?'Space':'Shift'])
}
{
 const events:HotkeyEvent[]=[];const sm=new HotkeyStateMachine(e=>events.push(e))
 sm.setBindings([{key:'Fn',modifiers:[],pushToTalk:false}])
 sm.handle(keyEvent('keyDown','Fn'));sm.handle(keyEvent('keyUp','Fn'))
 check('Solo Fn release starts dictation',events.map(e=>e.action),['start'])
 await sleep(220);sm.handle(keyEvent('keyDown','Fn'));sm.handle(keyEvent('keyUp','Fn'))
 check('Solo Fn second release stops',events.map(e=>e.action),['start','stop'])
}

// Regression: the user's configured RightCommand must stay right-specific,
// and ordinary Command shortcuts must never begin a recording.
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine(e => events.push(e))
  sm.setBindings([parseShortcutString('RightCommand')!])
  const physical = (type: 'keyDown' | 'keyUp', key: string, code: number, mods: string[] = []) => ({ ...keyEvent(type, key, mods), keyCode: code })
  sm.handle(physical('keyDown', 'LeftCommand', 0x37))
  sm.handle(physical('keyUp', 'LeftCommand', 0x37))
  check('RightCommand does not match LeftCommand', events.length, 0)
  sm.handle(physical('keyDown', 'RightCommand', 0x36))
  sm.handle(physical('keyDown', 'C', 0x08, ['Command']))
  sm.handle(physical('keyUp', 'RightCommand', 0x36))
  check('Cmd+C does not accidentally start dictation', events.length, 0)
  sm.handle(physical('keyDown', 'RightCommand', 0x36))
  check('Solo RightCommand waits until release', events.length, 0)
  sm.handle(physical('keyUp', 'RightCommand', 0x36))
  check('Solo RightCommand starts', events.map(e => e.action), ['start'])
  await sleep(200)
  sm.handle(physical('keyDown', 'RightCommand', 0x36))
  sm.handle(physical('keyUp', 'RightCommand', 0x36))
  check('Solo RightCommand stops', events.map(e => e.action), ['start', 'stop'])
}
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine(e => events.push(e))
  sm.setBindings([parseShortcutString('Fn')!, parseShortcutString('Fn+LeftShift')!])
  sm.handle({...keyEvent('keyDown','LeftShift'),keyCode:0x38})
  sm.handle({...keyEvent('keyDown','Fn',['Shift']),keyCode:0x3f})
  sm.handle({...keyEvent('keyUp','Fn',['Shift']),keyCode:0x3f})
  check('Shift then Fn selects translation exactly once', events.map(e => e.binding.key), ['Shift'])
}
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine(e => events.push(e))
  sm.setBindings([parseShortcutString('LeftControl+1')!])
  sm.handle(keyEvent('keyDown', '1', ['LeftControl']))
  check('Native modifier aliases and digits match', events.map(e => e.action), ['start'])
}
{
  const events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine(e => events.push(e))
  sm.setBindings([PTT])
  sm.handle(keyEvent('keyDown','Space',['Command','Shift']))
  sm.handle({...keyEvent('keyUp','LeftShift',['Command']),keyCode:0x38})
  check('PTT stops when a required modifier releases first',events.map(e=>e.action),['start','stop'])
}

// MARK: - WAV 编码
console.log('\n=== WAV 编码 ===')

{
  // 1 秒 16kHz 正弦波
  const sampleRate = 16000
  const samples = new Float32Array(sampleRate)
  for (let i = 0; i < sampleRate; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)

  const wav = encodeWav([samples], sampleRate)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const str = (pos: number, len: number) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(pos + i)))

  check('WAV: RIFF 标识', str(0, 4), 'RIFF')
  check('WAV: WAVE 标识', str(8, 4), 'WAVE')
  check('WAV: fmt 块', str(12, 4), 'fmt ')
  check('WAV: data 块', str(36, 4), 'data')
  check('WAV: 单声道', view.getUint16(22, true), 1)
  check('WAV: 采样率', view.getUint32(24, true), 16000)
  check('WAV: 位深 16', view.getUint16(34, true), 16)
  check('WAV: 数据长度 = 样本数*2', view.getUint32(40, true), sampleRate * 2)
  check('WAV: 总长 = 44 + 数据长度', wav.byteLength, 44 + sampleRate * 2)
  check('WAV: RIFF 长度字段 = 总长-8', view.getUint32(4, true), wav.byteLength - 8)
}

{
  // 多块拼接必须顺序正确，否则音频会断裂
  const a = new Float32Array([0.1, 0.2])
  const b = new Float32Array([0.3, 0.4])
  const wav = encodeWav([a, b], 16000)
  const view = new DataView(wav.buffer)
  const s0 = view.getInt16(44, true)
  const s3 = view.getInt16(50, true)
  check('WAV: 多块按顺序拼接', [s0 > 3000, s3 > 12000], [true, true])
}

{
  // 削波保护：超过 ±1 的样本必须被夹紧，否则会环绕成反相爆音
  const clipped = float32ToInt16(new Float32Array([2.5, -2.5, 0, 1, -1]))
  check('削波: 正溢出夹紧', clipped[0], 32767)
  check('削波: 负溢出夹紧', clipped[1], -32768)
  check('削波: 零值', clipped[2], 0)
  check('削波: 边界值不溢出', [clipped[3], clipped[4]], [32767, -32768])
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
