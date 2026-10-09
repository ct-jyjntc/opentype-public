import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { HotkeyStateMachine, parseShortcutString, HOLD_THRESHOLD_MS, type HotkeyEvent } from '../src/main/services/hotkey'
import { dispatchRecordingHotkey, reconcileCaptureState, bindRecordingPowerEvents } from '../src/main/services/recording-controls'
import { CaptureSession } from '../src/main/services/capture-session'
import { ShortcutCapture } from '../src/main/services/shortcut-capture'
import type { RecordingActivation, VoiceState } from '../src/shared/desktop'
import type { KeyEvent } from '../src/main/native/keyboard'
import type { HistoryRow, HistoryInsert } from '../src/main/db'
import type { TranscribeParams, TranscribeResult } from '../src/main/services/providers/types'
class Clock {
  time = 1000
  id = 0
  timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  schedule = (run: () => void, ms: number) => { const id = ++this.id; this.timers.set(id, { at: this.time + ms, run }); return id }
  clear = (id: unknown) => { this.timers.delete(id as number) }
  advance(ms: number) {
    const target = this.time + ms
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at; this.timers.delete(next[0]); next[1].run()
    }
    this.time = target
  }
}
const codes: Record<string, number> = { RightCommand: 0x36, LeftCommand: 0x37, Fn: 0x3f, LeftShift: 0x38, RightShift: 0x3c, C: 8, Space: 0x31, F8: 0x64, F9: 0x65 }
const event = (type: KeyEvent['type'], key: string, modifiers: string[] = [], isRepeat = false): KeyEvent => ({ type, key, keyCode: codes[key] ?? 0, modifiers, isRepeat, timestamp: 0 })
const bind = (name: string, activation: RecordingActivation = 'auto') => ({ ...parseShortcutString(name)!, activation })
function fixture(names = ['RightCommand'], mode: RecordingActivation = 'auto') {
  const clock = new Clock(), events: HotkeyEvent[] = []
  const sm = new HotkeyStateMachine(e => events.push(e), clock)
  sm.setBindings(names.map(name => bind(name, mode)))
  return { clock, events, sm,
    down: (key: string, mods: string[] = []) => sm.handle(event('keyDown', key, mods)),
    up: (key: string, mods: string[] = []) => sm.handle(event('keyUp', key, mods)),
    actions: () => events.map(e => e.action),
  }
}
let passed = 0
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('OK ' + name) }
await test('auto modifier tap latches and a later tap stops once', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(70); assert.deepEqual(f.actions(), [])
  f.up('RightCommand'); assert.deepEqual(f.actions(), ['start']); assert.equal(f.sm.releaseToStop, false)
  f.clock.advance(250); f.down('RightCommand'); f.clock.advance(70); f.up('RightCommand')
  assert.deepEqual(f.actions(), ['start', 'stop']); assert.equal(f.sm.recording, false)
})
await test('auto modifier hold starts only after chord guard and stops on release', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(HOLD_THRESHOLD_MS - 1)
  assert.deepEqual(f.actions(), []); f.clock.advance(1); assert.deepEqual(f.actions(), ['start'])
  assert.equal(f.sm.releaseToStop, true); f.clock.advance(700); f.up('RightCommand')
  f.up('RightCommand'); assert.deepEqual(f.actions(), ['start', 'stop'])
})
await test('left modifier cannot activate or release a right modifier recording', () => {
  const f = fixture(); f.down('LeftCommand'); f.clock.advance(500); f.up('LeftCommand'); assert.deepEqual(f.actions(), [])
  f.down('RightCommand'); f.clock.advance(500); f.up('LeftCommand'); assert.equal(f.sm.recording, true)
  f.up('RightCommand'); assert.deepEqual(f.actions(), ['start', 'stop'])
})
await test('Cmd+C before hold threshold never records', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(50); f.down('C', ['Command'])
  f.clock.advance(1000); f.up('C', ['Command']); f.up('RightCommand'); assert.deepEqual(f.actions(), [])
})
await test('turning an already held modifier into Cmd+C cancels without finalizing', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(500); f.down('C', ['Command'])
  f.up('RightCommand'); f.up('C'); assert.deepEqual(f.actions(), ['start', 'cancel'])
})
await test('Fn+Space wins over solo Fn and releases when Fn is released first', () => {
  const f = fixture(['Fn', 'Fn+Space']); f.down('Fn'); f.clock.advance(50); f.down('Space', ['Fn'])
  f.clock.advance(600); f.up('Fn'); f.up('Space'); assert.deepEqual(f.events.map(e => [e.action, e.binding.key]), [['start','Space'],['stop','Space']])
})
await test('modifier chord works in either press order with no solo-key residue', () => {
  for (const reversed of [false, true]) {
    const f = fixture(['Fn', 'Fn+LeftShift'])
    f.down(reversed ? 'LeftShift' : 'Fn'); f.clock.advance(50)
    f.down(reversed ? 'Fn' : 'LeftShift', [reversed ? 'Shift' : 'Fn']); f.clock.advance(400)
    f.up('Fn', ['Shift']); f.up('LeftShift'); f.clock.advance(500)
    assert.deepEqual(f.events.map(e => [e.action, e.binding.key]), [['start','Shift'],['stop','Shift']])
  }
})
await test('ordinary function-key auto mode starts immediately, taps latch, holds finish', () => {
  const short = fixture(['F8']); short.down('F8'); assert.deepEqual(short.actions(), ['start'])
  short.clock.advance(80); short.up('F8'); short.clock.advance(400); assert.equal(short.sm.recording, true)
  short.down('F8'); short.up('F8'); assert.deepEqual(short.actions(), ['start','stop'])
  const long = fixture(['F8']); long.down('F8'); long.clock.advance(400); assert.equal(long.sm.releaseToStop, true)
  long.up('F8'); assert.deepEqual(long.actions(), ['start','stop'])
})
await test('fixed toggle ignores hold duration and fixed hold does not latch', () => {
  const toggle = fixture(['RightCommand'], 'toggle'); toggle.down('RightCommand'); toggle.clock.advance(1000)
  assert.deepEqual(toggle.actions(), []); toggle.up('RightCommand'); assert.equal(toggle.sm.recording, true)
  const hold = fixture(['RightCommand'], 'hold'); hold.down('RightCommand'); hold.clock.advance(80); hold.up('RightCommand')
  assert.deepEqual(hold.actions(), []); hold.down('RightCommand'); hold.clock.advance(500); hold.up('RightCommand')
  assert.deepEqual(hold.actions(), ['start','stop'])
})
await test('repeat and bounce never produce an extra capture', () => {
  const f = fixture(['F8']); f.down('F8'); f.sm.handle(event('keyDown','F8',[],true))
  f.clock.advance(40); f.up('F8'); f.down('F8'); f.up('F8'); assert.deepEqual(f.actions(), ['start'])
})
await test('reset and rebind invalidate pending hold timers', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(150); f.sm.reset(); f.clock.advance(1000); f.up('RightCommand')
  assert.deepEqual(f.actions(), []); f.down('RightCommand'); f.sm.setBindings([bind('F8')]); f.clock.advance(1000)
  assert.deepEqual(f.actions(), []); assert.equal(f.clock.timers.size, 0); f.down('F8'); assert.deepEqual(f.actions(), ['start'])
})
await test('Esc cancels held capture and stale release cannot affect the next capture', () => {
  const f = fixture(['RightCommand','F8']); f.down('RightCommand'); f.clock.advance(500); f.sm.handleCancel()
  f.down('F8'); f.up('RightCommand'); assert.deepEqual(f.actions(), ['start','cancel','start'])
  assert.equal(f.sm.recording, true)
})
await test('shortcut editor suppresses all tap/hold activity and drains release on close', () => {
  const f = fixture(), editor = new ShortcutCapture(); let captured = ''
  const feed = (e: KeyEvent) => { if (!editor.handle(e)) f.sm.handle(e) }
  f.down('RightCommand'); f.clock.advance(100); f.sm.reset(); editor.begin('edit',1,s=>{captured=s.shortcut??captured})
  feed(event('keyDown','RightCommand')); f.clock.advance(1000); assert.equal(captured,'RightCommand')
  assert.deepEqual(f.actions(),[]); editor.end('edit'); feed(event('keyUp','RightCommand')); assert.deepEqual(f.actions(),[])
})
await test('rejected start leaves no phantom hotkey and permits an immediate fresh gesture', () => {
  const clock = new Clock(); let accept = false, starts = 0
  const sm = new HotkeyStateMachine(() => { starts++; return accept },clock); sm.setBindings([bind('F8')])
  sm.handle(event('keyDown','F8')); sm.handle(event('keyUp','F8')); assert.equal(sm.recording,false)
  accept = true; sm.handle(event('keyDown','F8')); assert.equal(starts,2); assert.equal(sm.recording,true)
})
await test('ordinary typing during latched dictation does not cancel it', () => {
  const f = fixture(); f.down('RightCommand'); f.clock.advance(70); f.up('RightCommand'); f.clock.advance(300)
  f.down('C'); f.up('C'); assert.deepEqual(f.actions(),['start']); assert.equal(f.sm.recording,true)
})
function deferred<T>() { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>{resolve=r}); return {promise,resolve} }
function recorderFixture(transcribe: (p: TranscribeParams)=>Promise<TranscribeResult> = async()=>({success:true,text:'test output'})) {
  const clock = new Clock(), rows = new Map<string,HistoryInsert>(), inserted:string[]=[], states:VoiceState[]=[], jobs:Promise<unknown>[]=[]
  let capture!:CaptureSession, enabled=true
  const sm = new HotkeyStateMachine(e=>dispatchRecordingHotkey(e,{
    enabled:()=>enabled,busy:()=>capture.isBusy,recording:()=>capture.isRecording,
    start:()=>{void capture.onStart();capture.pushAudio(new Float32Array(16000),16000,0)},
    stop:()=>{jobs.push(capture.onStop())},cancel:()=>capture.onCancel(),
  }),clock)
  sm.setBindings([bind('RightCommand'),bind('F8')])
  capture=new CaptureSession({
    provider:{name:'test',transcribe},
    getConfig:()=>({mode:'voice_transcript',outputLanguage:'zh',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
    context:()=>({appName:'Editor',bundleId:'test.editor',audioContext:{},selectedText:''}),
    notify:s=>states.push(reconcileCaptureState(sm,s)),flush:async()=>{},saveAudio:async id=>id+'.wav',
    saveHistory:async r=>{rows.set(r.id,{...rows.get(r.id),...r})},loadHistory:async id=>(rows.get(id) as HistoryRow)??null,
    inject:async text=>{inserted.push(text)},showCard:()=>{},changed:()=>{},personalization:async()=>({}),
  })
  return {clock,sm,capture,states,inserted,jobs,rows,disable:()=>{enabled=false;sm.reset();capture.onCancel()}}
}
await test('held native gesture reaches capture finalization and inserts exactly once', async()=>{
  const f=recorderFixture(); f.sm.handle(event('keyDown','RightCommand'));f.clock.advance(500)
  assert.equal(f.capture.isRecording,true);assert.equal(f.states.at(-1)?.stopGesture,'release')
  f.sm.handle(event('keyUp','RightCommand'));await Promise.all(f.jobs)
  assert.deepEqual(f.inserted,['test output']);assert.equal(f.capture.isBusy,false);assert.equal(f.sm.recording,false)
  f.capture.dispose()
})
await test('UI-started capture stops via hotkey and processing rejects new capture', async()=>{
  const response=deferred<TranscribeResult>(), entered=deferred<void>()
  const f=recorderFixture(async()=>{entered.resolve();return response.promise})
  await f.capture.onStart();f.capture.pushAudio(new Float32Array(16000),16000,0)
  f.sm.handle(event('keyDown','F8'));await entered.promise
  assert.equal(f.capture.isRecording,false);f.sm.handle(event('keyUp','F8'));f.sm.handle(event('keyDown','F8'))
  assert.equal(f.sm.recording,false);response.resolve({success:true,text:'one'});await Promise.all(f.jobs)
  assert.deepEqual(f.inserted,['one']);f.capture.dispose()
})
await test('renderer capture failure resets held gesture before a fresh recording', async()=>{
  const f=recorderFixture();f.sm.handle(event('keyDown','RightCommand'));f.clock.advance(500)
  f.capture.captureFailed(f.states.at(-1)!.audioId!);f.sm.handle(event('keyUp','RightCommand'))
  assert.equal(f.sm.recording,false);assert.equal(f.capture.isBusy,false);assert.deepEqual(f.inserted,[])
  f.sm.handle(event('keyDown','F8'));assert.equal(f.capture.isRecording,true);f.capture.dispose()
})
await test('disabled recording invalidates held key and pending activation',()=>{
  const f=recorderFixture();f.sm.handle(event('keyDown','RightCommand'));f.clock.advance(100);f.disable();f.clock.advance(1000)
  f.sm.handle(event('keyUp','RightCommand'));f.sm.handle(event('keyDown','F8'))
  assert.equal(f.capture.isBusy,false);assert.equal(f.sm.recording,false);f.capture.dispose()
})
await test('sleep and lock cancel recording; resume while locked cannot restart monitoring',()=>{
  const source=new EventEmitter(),f=recorderFixture();let starts=0,stops=0
  const power=bindRecordingPowerEvents(source,{suspend:()=>{f.sm.reset();f.capture.onCancel();stops++},resume:()=>{starts++}})
  f.sm.handle(event('keyDown','RightCommand'));f.clock.advance(500);assert.equal(f.capture.isBusy,true)
  source.emit('lock-screen');source.emit('suspend');assert.equal(f.capture.isBusy,false);assert.equal(power.paused(),true)
  source.emit('resume');assert.equal(starts,0);assert.equal(power.paused(),true)
  source.emit('unlock-screen');assert.equal(starts,1);assert.equal(stops,2);assert.equal(power.paused(),false)
  f.sm.handle(event('keyUp','RightCommand'));assert.deepEqual(f.inserted,[])
  power.dispose();assert.equal(source.listenerCount('resume'),0);f.capture.dispose()
})
console.log(`recording controls: ${passed} scenarios passed`)
