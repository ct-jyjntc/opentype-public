import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnswerCardSession, type AnswerCardDeps } from '../src/main/services/answer-card'
import { capturedContext } from '../src/main/services/capture-context'
import { initDatabase, closeDatabase, HistoryRepo } from '../src/main/db'
import type { CardPayload } from '../src/shared/desktop'
let count = 0
async function test(name: string, run: () => Promise<void> | void) { await run(); count++; console.log('OK ' + name) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function fixture(overrides: Partial<AnswerCardDeps> = {}) {
  const shown: CardPayload[] = [], released: string[] = [], sent: unknown[] = [], saved: unknown[] = []
  const deps: AnswerCardDeps = {
    show: p => { shown.push(p) }, release: t => { released.push(t) }, validate: async () => {},
    deliver: async (token,text) => { sent.push({token,text}); return {status:'verified',method:'clipboard'} },
    saveDelivery: async (p,o) => { saved.push({id:p.audioId,...o}) }, ...overrides,
  }
  const session = new AnswerCardSession(deps)
  const present = () => session.present({text:'Reviewed answer',title:'随便问',audioId:'record'}, {token:'native-private-token',selectedText:'original selection',appName:'Editor'})
  const id = () => shown.at(-1)!.id!
  return {session,deps,shown,released,sent,saved,present,id}
}
await test('readonly or missing selections show an answer without replacement authority', async () => {
  const f=fixture();assert.equal(f.session.present({text:'Explanation',canReplaceSelection:true,id:'untrusted-renderer'}),false)
  assert.equal(f.shown[0].canReplaceSelection,false);assert.notEqual(f.id(),'untrusted-renderer');assert.equal(f.sent.length,0)
  await assert.rejects(f.session.replace(f.id()),/answer_selection_expired/)
})
await test('answer waits for explicit apply, never exposes native handle, and applies immutable result once',async()=>{
  const f=fixture();assert.equal(f.present(),true);assert.equal(f.sent.length,0);assert.equal(f.released.length,0)
  assert(!JSON.stringify(f.shown).includes('native-private-token'));assert(!JSON.stringify(f.shown).includes('original selection'))
  const applying=f.session.replace(f.id());await assert.rejects(f.session.replace(f.id()),/answer_selection_expired/);await applying
  assert.deepEqual(f.sent,[{token:'native-private-token',text:'Reviewed answer'}]);assert.equal(f.shown.at(-1)?.detail,'answer_selection_replaced')
  f.session.close();assert.deepEqual(f.released,['native-private-token'])
})
await test('new card invalidates old action ID and releases its original target',async()=>{
  const f=fixture();f.present();const old=f.id();f.session.present({text:'New answer'})
  await assert.rejects(f.session.replace(old),/answer_selection_expired/);assert.equal(f.sent.length,0);assert.equal(f.released.length,1)
})
await test('closing during pending validation prevents all insertion and does not reopen the card',async()=>{
  const gate=deferred();const f=fixture({validate:()=>gate.promise});f.present();const p=f.session.replace(f.id());f.session.close();const before=f.shown.length;gate.resolve();await p
  assert.equal(f.sent.length,0);assert.equal(f.shown.length,before);assert.equal(f.saved.length,0);assert.equal(f.released.length,1)
})
await test('late delivery after a new card preserves outcome without replacing new UI',async()=>{
  const gate=deferred();const entered=deferred();const f=fixture({deliver:async()=>{entered.resolve();await gate.promise;return {status:'unverified',method:'clipboard',detail:'injection_cancelled_after_send'}}})
  f.present();const p=f.session.replace(f.id());await entered.promise;f.session.present({text:'Newer answer'});const before=f.shown.length;gate.resolve();await p
  assert.equal(f.shown.length,before);assert.equal(f.shown.at(-1)?.text,'Newer answer');assert.equal((f.saved[0] as any).status,'unverified');assert.equal(f.released.length,1)
})
await test('stale history or changed target leaves answer copyable and never retries insertion',async()=>{
  for(const failure of ['answer_record_changed','injection_target_changed']){
    const f=fixture(failure==='answer_record_changed'?{validate:async()=>{throw new Error(failure)}}:{deliver:async()=>{throw new Error(failure)}})
    f.present();await f.session.replace(f.id());assert.equal(f.shown.at(-1)?.detail,failure);assert.equal(f.shown.at(-1)?.text,'Reviewed answer');assert.equal(f.released.length,1)
    await assert.rejects(f.session.replace(f.id()),/answer_selection_expired/)
  }
})
await test('uncertain submission and metadata save failure do not enable repeat paste',async()=>{
  for(const failSave of [false,true]){
    const f=fixture({deliver:async()=>({status:'unverified',method:'clipboard',detail:'injection_unverified'}),saveDelivery:async()=>{if(failSave)throw new Error('disk full')}})
    f.present();await f.session.replace(f.id());assert.equal(f.shown.at(-1)?.detail,failSave?'injection_history_save_failed':'injection_unverified');assert.equal(f.shown.at(-1)?.canReplaceSelection,false)
  }
})
await test('recording busy leaves the original action available for a later explicit retry',async()=>{
  let busy=true;const f=fixture({validate:async()=>{if(busy)throw new Error('answer_recording_busy')}})
  f.present();await f.session.replace(f.id());assert.equal(f.shown.at(-1)?.canReplaceSelection,true);assert.equal(f.released.length,0)
  busy=false;await f.session.replace(f.id());assert.equal(f.sent.length,1);assert.equal(f.released.length,1)
})
await test('capture privacy strips readonly selections for sensitive apps, blocked ancestor pages and unknown document origins',()=>{
  const base={appName:'Editor',bundleId:'test.editor',pid:1,selectedText:'private selected text',contextText:'private context',token:'private-token',webUrl:'https://allowed.test/frame',webUrls:['https://allowed.test/frame','https://blocked.test/document']}
  for(const target of [base,{...base,webUrls:[],bundleId:'com.apple.mail'},{...base,webUrls:[],contextRedacted:true}]){
    const output=capturedContext(target,['blocked.test']);assert.equal(output.selectedText,'');assert.equal(output.audioContext.redacted,true);assert.equal(output.audioContext.input_context,'');assert(!JSON.stringify(output.audioContext).includes('private-token'))
  }
  const allowed=capturedContext({...base,webUrls:['https://allowed.test/frame']},['blocked.test'])
  assert.equal(allowed.selectedText,'private selected text');assert.equal(allowed.audioContext.redacted,false)
})
const dir=mkdtempSync(join(tmpdir(),'opentype-answer-history-'));initDatabase(dir)
try {
 await test('real history delivery update preserves answer, raw text and unrelated metadata',async()=>{
   await HistoryRepo.upsert({id:'answer',status:'completed',mode:'voice_command',refinedText:'Reviewed answer',modeMeta:JSON.stringify({raw_text:'Explain this',selected_text:'source',delivery:'card'})})
   assert.equal(await HistoryRepo.recordInputDelivery('answer','Reviewed answer',{status:'verified',method:'clipboard'}),true)
   const row=await HistoryRepo.byId('answer');assert.equal(row?.refinedText,'Reviewed answer');const meta=JSON.parse(row!.modeMeta!);assert.equal(meta.raw_text,'Explain this');assert.equal(meta.selected_text,'source');assert.equal(meta.input_delivery,'verified')
 })
 await test('changed, retrying and missing history cannot be overwritten or recreated by a stale card',async()=>{
   await HistoryRepo.upsert({id:'answer',editedText:'User edit'})
   assert.equal(await HistoryRepo.recordInputDelivery('answer','Reviewed answer',{status:'failed',detail:'injection_target_changed'}),false)
   assert.equal((await HistoryRepo.byId('answer'))?.editedText,'User edit')
   await HistoryRepo.upsert({id:'answer',status:'transcribing',editedText:null})
   assert.equal(await HistoryRepo.recordInputDelivery('answer','Reviewed answer',{status:'verified'}),false)
   assert.equal(await HistoryRepo.recordInputDelivery('missing','Reviewed answer',{status:'verified'}),false);assert.equal(await HistoryRepo.byId('missing'),null)
   await HistoryRepo.remove('answer');assert.equal(await HistoryRepo.recordInputDelivery('answer','Reviewed answer',{status:'verified'}),false);assert.equal(await HistoryRepo.byId('answer'),null)
 })
} finally {closeDatabase()}
console.log(`${count} answer-card and selection privacy scenarios passed`)
