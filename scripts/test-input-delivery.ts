import assert from 'node:assert/strict'
import { captureReadableInput, deliverToInput, type InputDeliveryNative, type InputSnapshot } from '../src/main/services/input-delivery'
let count = 0
async function test(name: string, run: () => Promise<void>) { await run(); count++; console.log('OK ' + name) }
await test('initial Chromium AX bootstrap retries before preserving a readable insertion baseline',async()=>{
  let captures=0;const released:string[]=[],pids:(number|undefined)[]=[]
  const result=await captureReadableInput(pid=>{pids.push(pid);captures++;return {pid:42,appName:'Test',bundleId:'test.editor',token:'t'+captures,canVerify:captures===3,contextRedacted:captures!==3} },token=>released.push(token),new AbortController().signal,async()=>{})
  assert.equal(result.token,'t3');assert.equal(result.contextRedacted,false);assert.deepEqual(released,['t1','t2']);assert.deepEqual(pids,[undefined,42,42])
})
await test('unreadable applications have a bounded fallback and keep exactly one owned token',async()=>{
  let captures=0;const released:string[]=[]
  const result=await captureReadableInput(()=>({pid:42,appName:'Test',bundleId:'test.editor',token:'t'+(++captures),canVerify:false}),token=>released.push(token),new AbortController().signal,async()=>{})
  assert.equal(captures,13);assert.equal(result.token,'t13');assert.equal(released.length,12)
})
await test('capture cancellation, native failure and process switch release incomplete snapshots',async()=>{
  for(const action of ['cancel','throw','switch'] as const){
    const controller=new AbortController(),released:string[]=[];let captures=0
    const run=()=>captureReadableInput(()=>{captures++;if(captures>1&&action==='throw')throw Error('read failed');return {pid:captures>1&&action==='switch'?43:42,appName:'Test',bundleId:'test.editor',token:'t'+captures,canVerify:false}},token=>released.push(token),controller.signal,async()=>{if(action==='cancel')controller.abort()})
    if(action==='switch'){const result=await run();assert.equal(result.reason,'injection_app_changed');assert(!result.token);assert.deepEqual(released,['t1','t2'])}
    else{await assert.rejects(run());assert.deepEqual(released,['t1'])}
  }
})
await test('readable fields, read-only selections, and denied targets do not retry or discard context',async()=>{
  for(const snapshot of [ {pid:42,appName:'Test',bundleId:'test.editor',token:'t',canVerify:true}, {pid:42,appName:'Test',bundleId:'test.editor',canVerify:false,selectionReadOnly:true,selectedText:'Read-only text'}, {pid:42,appName:'Test',bundleId:'test.editor',reason:'injection_permission'} ] satisfies InputSnapshot[]){
    let captures=0;const result=await captureReadableInput(()=>{captures++;return snapshot},()=>{throw Error('unexpected release')},new AbortController().signal,async()=>{})
    assert.equal(captures,1);assert.deepEqual(result,snapshot)
  }
})
function fixture(overrides: Partial<InputDeliveryNative> = {}) {
  const calls: string[] = [], controller = new AbortController()
  const native: InputDeliveryNative = {
    prepare: () => { calls.push('prepare'); return { ok: true } },
    ready: () => { calls.push('ready'); return { ok: true } },
    commit: () => { calls.push('commit'); return { submitted: true, method: 'accessibility' } },
    verify: () => { calls.push('verify'); return { status: 'verified' } }, ...overrides,
  }
  const run = (pause: (ms: number) => Promise<void> = async () => {}) =>
    deliverToInput(native, { token: 'original-window-field' }, 'new text', controller.signal, undefined, pause)
  return { native, calls, controller, run }
}
await test('confirmed input is committed once to the captured token, after readiness', async () => {
  const f = fixture(); assert.equal((await f.run()).status, 'verified'); assert.deepEqual(f.calls, ['prepare','ready','commit','verify'])
})
await test('missing permissions, invalid targets, changed contents and changed selection never commit', async () => {
  for (const reason of ['injection_permission','injection_target_closed','injection_target_changed','injection_selection_changed','injection_app_changed']) {
    const f = fixture({ ready: () => ({ reason }) }); await assert.rejects(f.run(), new RegExp(reason)); assert(!f.calls.includes('commit'))
  }
  const f=fixture(); await assert.rejects(deliverToInput(f.native, {reason:'injection_target_unavailable'},'text',f.controller.signal), /injection_target_unavailable/); assert.equal(f.calls.length,0)
})
await test('focus readiness waits asynchronously and times out without any paste', async () => {
  let checks=0
  const f=fixture({ready:()=>++checks===3?{ok:true}:{reason:'injection_focus_pending'}})
  assert.equal((await f.run()).status,'verified'); assert.equal(checks,3)
  const stalled=fixture({ready:()=>({reason:'injection_focus_pending'})})
  await assert.rejects(stalled.run(),/injection_focus_timeout/);assert(!stalled.calls.includes('commit'))
})
await test('cancel before preparation or while waiting prevents commit', async () => {
  const before=fixture();before.controller.abort();await assert.rejects(before.run());assert.equal(before.calls.length,0)
  const during=fixture({ready:()=>({reason:'injection_focus_pending'})});await assert.rejects(during.run(async()=>{during.controller.abort()}));assert(!during.calls.includes('commit'))
})
await test('clipboard delivery verifies later without resending text', async () => {
  let checks=0
  const f=fixture({verify:()=>({status:++checks===4?'verified':'pending'})})
  assert.equal((await f.run()).status,'verified');assert.equal(f.calls.filter(c=>c==='commit').length,1);assert.equal(checks,4)
})
await test('unreadable fields, partial AX errors and uncertain results never auto-retry', async () => {
  for(const verify of [()=>({status:'unverified' as const}),()=>({status:'pending' as const}),()=>({reason:'injection_target_closed'})]){
    const f=fixture({verify});const result=await f.run();assert.equal(result.status,'unverified');assert.equal(result.detail,'injection_unverified');assert.equal(f.calls.filter(c=>c==='commit').length,1)
  }
  const f=fixture({commit:()=>({submitted:true,method:'accessibility',uncertain:true})});assert.equal((await f.run()).status,'unverified');assert(!f.calls.includes('verify'))
})
await test('blind typing into an app without a readable field raises no warning and never retries', async () => {
  let commits=0,verifies=0
  const f=fixture({commit:()=>(commits++,{submitted:true,method:'windows_typing'}),verify:()=>(verifies++,{status:'unverified',blind:true})})
  const result=await f.run();assert.equal(result.status,'unverified');assert.equal(result.method,'windows_typing');assert.equal(result.detail,undefined)
  assert.equal(commits,1);assert.equal(verifies,1)
})
await test('native dispatch failures are reported and cancel after submission is not reported as unsent', async () => {
  const failed=fixture({commit:()=>({reason:'injection_failed'})});await assert.rejects(failed.run(),/injection_failed/)
  const f=fixture({verify:()=>({status:'pending'})});const result=await f.run(async()=>{f.controller.abort()});assert.equal(result.detail,'injection_cancelled_after_send');assert.equal(f.calls.filter(c=>c==='commit').length,1)
})
await test('async native preparation and delayed selection restore settle before a single commit', async () => {
  let checks = 0, prepared = false
  const f = fixture({
    prepare: async () => { await Promise.resolve(); prepared = true; return { ok: true } },
    ready: () => { assert(prepared); return ++checks < 3 ? { reason: 'injection_selection_changed' } : { ok: true } },
    commit: async () => { await Promise.resolve(); f.calls.push('commit'); return { submitted: true, method: 'clipboard' } },
  })
  assert.equal((await f.run()).status, 'verified'); assert.equal(checks, 3)
  assert.equal(f.calls.filter(c => c === 'commit').length, 1)
})
await test('cancel while native preparation is queued prevents the subsequent commit', async () => {
  const f = fixture({ prepare: async () => { f.controller.abort(); return { ok: true } } })
  await assert.rejects(f.run()); assert(!f.calls.includes('commit'))
})
await test('cancel during async commit reports possible delivery instead of offering another paste', async () => {
  const f = fixture({ commit: async () => { f.controller.abort(); return { submitted: true, method: 'clipboard' } } })
  assert.equal((await f.run()).detail, 'injection_cancelled_after_send'); assert(!f.calls.includes('verify'))
})
await test('commit and verification bridge failures cannot be mistaken for unsent text', async () => {
  const commitError = fixture({commit:async()=>{throw new Error('bridge disconnected')}})
  assert.equal((await commitError.run()).status,'unverified')
  const verifyError = fixture({verify:()=>{throw new Error('bridge disconnected')}})
  assert.equal((await verifyError.run()).status,'unverified')
  assert.equal(verifyError.calls.filter(c=>c==='commit').length,1)
  const duplicate = fixture({commit:()=>({reason:'injection_already_sent'})})
  assert.equal((await duplicate.run()).detail,'injection_already_sent')
  const incomplete = fixture({commit:()=>({})})
  assert.equal((await incomplete.run()).status,'unverified')
})
console.log(`${count} input delivery scenarios passed`)
