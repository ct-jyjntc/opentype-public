import { app } from 'electron'
import koffi from 'koffi'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createKeyboardMonitor, type KeyEvent } from '../src/main/native/keyboard'
import { ShortcutCapture } from '../src/main/services/shortcut-capture'
import { HotkeyStateMachine, parseShortcutString } from '../src/main/services/hotkey'
const lib = koffi.load(path.resolve('node_modules/.cache/libKeyboardTest.dylib'))
const monitor = createKeyboardMonitor(lib)
const disable = lib.func('testDisableKeyboardTap', 'void', [])
const recover = lib.func('testRecoverKeyboardTap', 'void', [])
const deliver = lib.func('testDeliverKeyboardEvent', 'void', ['int', 'int', 'uint64'])
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const flush = () => new Promise<void>(r => setImmediate(r))
async function run() {
  const received: KeyEvent[] = [], actions: string[] = []
  const hotkeys = new HotkeyStateMachine(e => actions.push(e.action))
  const capture = new ShortcutCapture()
  const feed = (e: KeyEvent) => { received.push(e); if (!capture.handle(e)) hotkeys.handle(e) }
  const rc = monitor.startMonitor(feed)
  const initial = monitor.getStatus()
  console.log('native monitor status', initial, 'start', rc)
  assert.equal(initial.callbackRegistered, true)
  assert.equal(initial.requested, true)
  if (!initial.inputMonitoring) assert.equal(rc, -1)
  else { assert.equal(rc, 0); assert.equal(initial.active, true) }

  hotkeys.setBindings([parseShortcutString('RightCommand')!])
  deliver(0x36, 12, 1 << 20)
  assert.equal(received.length, 0, 'native callback must return before JS recording work')
  deliver(0x36, 12, 0)
  await flush()
  assert.deepEqual(actions, ['start'])
  await pause(200)
  deliver(0x36, 12, 1 << 20); deliver(0x36, 12, 0)
  await flush()
  assert.deepEqual(actions, ['start', 'stop'])
  console.log('PASS Swift physical key → Koffi → deferred JS → recording start/stop')
  let captured = ''
  capture.begin('settings', 1, state => { captured = state.shortcut ?? captured })
  await pause(200)
  deliver(0x36, 12, 1 << 20); deliver(0x36, 12, 0)
  await flush()
  assert.equal(captured, 'RightCommand')
  assert.deepEqual(actions, ['start', 'stop'], 'editing must not start a capsule')
  capture.end('settings')
  console.log('PASS native RightCommand is captured by shortcut editor without recording')

  // The editor deliberately drains native events at or before its closing millisecond.
  // A fresh physical gesture must have a later timestamp than that cutoff.
  await pause(5)
  hotkeys.setBindings([{ ...parseShortcutString('RightCommand')!, activation: 'auto' }])
  const beforeHold = actions.length
  deliver(0x36, 12, 1 << 20); await flush()
  assert.equal(actions.length, beforeHold, 'modifier must leave time for a normal chord')
  await pause(360)
  assert.deepEqual(actions.slice(beforeHold), ['start'])
  assert.equal(hotkeys.releaseToStop, true)
  deliver(0x36, 12, 0); await flush()
  assert.deepEqual(actions.slice(beforeHold), ['start', 'stop'])
  hotkeys.reset()
  deliver(0x36, 12, 1 << 20); deliver(0x08, 10, 1 << 20)
  deliver(0x08, 11, 1 << 20); deliver(0x36, 12, 0); await flush(); await pause(360)
  assert.deepEqual(actions.slice(beforeHold), ['start', 'stop'], 'native Cmd+C cancels pending hold')
  console.log('PASS Swift RightCommand hold → delayed start → release stop; Cmd+C never records')

  deliver(0x12, 10, 1 << 18)
  await flush()
  assert.equal(received.at(-1)?.key, '1')
  assert.deepEqual(received.at(-1)?.modifiers, ['Control'])

  if (initial.active) {
    disable()
    assert.equal(monitor.getStatus().active, false)
    await pause(2400)
    assert.equal(monitor.getStatus().active, true)
    assert.equal(monitor.getStatus().callbackRegistered, true)
    const before = received.length
    deliver(0x64, 10, 0); await flush()
    assert.equal(received.length, before + 1, 'watchdog must preserve callback delivery')
    // Repeat to prove the watchdog itself survived the first recovery.
    disable(); await pause(2400)
    assert.equal(monitor.getStatus().active, true)
    assert.ok(monitor.getStatus().recoveryCount >= 2)
    console.log('PASS real CGEventTap disabled twice → watchdog resumes twice with callback intact')
  } else {
    recover()
    assert.equal(monitor.getStatus().active, false)
    assert.equal(monitor.getStatus().callbackRegistered, true)
    console.log('PASS missing permission remains retryable; OS tap recovery needs authorized host')
  }
  const beforeStop = received.length
  deliver(0x64, 10, 0)
  monitor.stopMonitor()
  await flush()
  assert.equal(received.length, beforeStop, 'stop must discard already queued key events')
  assert.equal(monitor.getStatus().callbackRegistered, false)
  assert.equal(monitor.getStatus().requested, false)
  recover()
  assert.equal(monitor.getStatus().active, false, 'explicit stop must not be undone')
  // Previously each restart leaked a Koffi callback slot (limit 8192).
  for (let i = 0; i < 8300; i++) { monitor.startMonitor(feed); monitor.stopMonitor() }
  console.log('PASS 8300 start/stop cycles without callback exhaustion')
}
app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error); monitor.stopMonitor(); app.exit(1)
})
