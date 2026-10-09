import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, closeDatabase, HistoryRepo, CorrectionRepo, DictionaryRepo } from '../src/main/db'
import { InputCorrections } from '../src/main/services/input-corrections'
import type { CaptureTarget } from '../src/main/services/capture-session'
const dir = mkdtempSync(join(tmpdir(), 'opentype-input-corrections-'))
const original = 'Please use Opentipe and SenceVoice today.'
const corrected = 'Please use OpenType and SenseVoice today.'
let count=0
const test=async(name:string,fn:()=>void|Promise<void>)=>{await fn();count++;console.log('OK '+name)}
async function fixture(patch: Parameters<typeof HistoryRepo.upsert>[0] = {id:''}) {
  const id = patch.id || crypto.randomUUID()
  await HistoryRepo.upsert({...patch,id,status:patch.status??'completed',mode:patch.mode??'voice_transcript',refinedText:original,
    modeMeta:patch.modeMeta??JSON.stringify({input_delivery:'verified',raw_text:original}),focusedAppName:'Disposable editor',focusedAppBundleId:'test.editor'})
  let now=0,enabled=true,active=true,text=original,blacklist:string[]=[],begins=0,cancels=0,throws=false
  const released:string[]=[]
  const target:CaptureTarget={inputToken:id,appName:'Disposable editor',bundleId:'test.editor',selectedText:'',audioContext:{},inputWebDomains:['frame.test','parent.test']}
  const tracker=new InputCorrections({
    native:{begin:()=>{begins++;return {ok:true}},read:()=>{if(throws)throw new Error('native gone');return {active,text}},release:t=>released.push(t)},
    now:()=>now,enabled:()=>enabled,schedule:()=>()=>{cancels++},
    allowed:(id,t,ctx)=>CorrectionRepo.canObserve(id,t,blacklist,ctx.inputWebDomains),
    save:(id,t,after,ctx)=>CorrectionRepo.observeEdit(id,t,after,blacklist,ctx.inputWebDomains).active,
  })
  return {id,target,tracker,released,start:()=>tracker.start(id,original,target),
    tick:(ms=250)=>{now+=ms;tracker.poll()},change:(v:string)=>{text=v},disable:()=>{enabled=false},leave:()=>{active=false},block:()=>{blacklist=['parent.test']},fail:()=>{throws=true},
    get begins(){return begins},get cancels(){return cancels},candidates:()=>CorrectionRepo.list(0,id)}
}
try {
  initDatabase(join(dir,'history.db'))
  await test('verified input settles before proposing pairs, preserving history, sync state and dictionary',async()=>{
    const f=await fixture();const before=await HistoryRepo.byId(f.id)
    assert(f.start());f.change(corrected);f.tick();f.tick(1000);assert.equal(f.candidates().total,0)
    f.tick(500);assert.equal(f.candidates().total,2);assert.equal(f.candidates().items[0].sourceKind,'input_edit')
    assert.deepEqual(await HistoryRepo.byId(f.id),before);assert.equal((await DictionaryRepo.list('local')).length,0)
    f.tracker.stop();f.tracker.stop();assert.deepEqual(f.released,[f.id]);assert.equal(f.cancels,1)
  })
  await test('undo and new edits remove stale pending proposals before settling again',async()=>{
    const f=await fixture();f.start();f.change(corrected);f.tick();f.tick(1500);assert.equal(f.candidates().total,2)
    f.change(original);f.tick();assert.equal(f.candidates().total,0)
    f.change('Please use OpenType and SenceVoice today.');f.tick();f.tick(1500);assert.equal(f.candidates().total,1);f.tracker.stop()
  })
  await test('pending words require review, retain input source, allow dismiss and explicit revocation',async()=>{
    const f=await fixture();f.start();f.change(corrected);f.tick();f.tick(1500)
    const [a,b]=f.candidates().items;CorrectionRepo.dismiss(a.id)
    const accepted=CorrectionRepo.accept(b.id,b.replacement,b.original)
    const word=(await DictionaryRepo.list('local')).find(w=>w.id===accepted.dictionaryId)!
    assert.equal(word.sourceKind,'input_edit');assert.equal(word.sourceHistoryId,f.id)
    f.change(original);f.tick();f.change(corrected);f.tick();f.tick(1500);assert.equal(f.candidates().total,0)
    await DictionaryRepo.remove('local',word.id);assert.equal((await HistoryRepo.byId(f.id))?.editedText,null);f.tracker.stop()
  })
  await test('disabled, redacted, unverified and non-dictation sources never start observation',async()=>{
    for(const patch of [{id:'unverified',modeMeta:'{}'},{id:'translation',mode:'voice_translation' as const},{id:'failed',status:'failed' as const}]) {
      const f=await fixture(patch);assert.equal(f.start(),false);assert.equal(f.begins,0)
    }
    const f=await fixture();f.disable();assert.equal(f.start(),false);assert.equal(f.begins,0)
    const p=await fixture();p.target.audioContext.redacted=true;assert.equal(p.start(),false)
  })
  await test('switch target, timeout, disabling and native failure release the exact token once',async()=>{
    for(const action of ['leave','disable','fail','timeout'] as const){
      const f=await fixture();f.start();f.change(corrected);f.tick()
      if(action==='timeout')f.tick(60_000);else {f[action]();f.tick()}
      f.tracker.poll();f.tracker.stop();assert.deepEqual(f.released,[f.id]);assert.equal(f.candidates().total,0)
    }
  })
  await test('new capture replaces ownership without carrying previous draft corrections',async()=>{
    const f=await fixture(),g=await fixture();f.start();f.change(corrected);f.tick()
    assert(f.tracker.start(g.id,original,g.target));assert.deepEqual(f.released,[f.id]);assert.equal(f.candidates().total,0)
    f.tracker.stop();assert.deepEqual(f.released,[f.id,g.id])
  })
  await test('parent-page blacklist stops observation and blocks later acceptance',async()=>{
    const f=await fixture();f.start();f.change(corrected);f.tick();f.tick(1500);const c=f.candidates().items[0]
    f.block();f.tick();assert.deepEqual(f.released,[f.id]);assert.throws(()=>CorrectionRepo.accept(c.id,c.replacement,c.original,['parent.test']),/correction_stale/)
    const p=await fixture();p.block();assert.equal(p.start(),false)
  })
  await test('manual history editing and retries invalidate input proposals and cannot be overwritten',async()=>{
    for(const kind of ['edit','retry'] as const){
      const f=await fixture();f.start();f.change(corrected);f.tick();f.tick(1500)
      if(kind==='edit')CorrectionRepo.saveEdit(f.id,'User changed history',false)
      else await HistoryRepo.upsert({id:f.id,refinedText:'New recognition'})
      f.tick();assert.equal(f.candidates().total,0);assert.deepEqual(f.released,[f.id])
      assert.equal(CorrectionRepo.observeEdit(f.id,original,corrected).active,false)
    }
  })
  await test('deleted source is never recreated by a late observation',async()=>{
    const f=await fixture();f.start();f.change(corrected);f.tick();await HistoryRepo.remove(f.id);f.tick(1500)
    assert.equal(await HistoryRepo.byId(f.id),null);assert.equal(f.candidates().total,0);assert.deepEqual(f.released,[f.id])
  })
  await test('formatting, appended text and broad rewrites never become word corrections',async()=>{
    const f=await fixture();f.start();f.change(original+' Another new sentence.');f.tick();f.tick(1500);assert.equal(f.candidates().total,0)
    f.change('Completely unrelated new content');f.tick();f.tick(1500);assert.equal(f.candidates().total,0);f.tracker.stop()
  })
  await test('pending input suggestions survive database restart without restoring native observation',async()=>{
    const f=await fixture();f.start();f.change(corrected);f.tick();f.tick(1500);f.tracker.stop()
    closeDatabase();initDatabase(join(dir,'history.db'));assert.equal(f.candidates().total,2)
    const c=f.candidates().items[0];assert(CorrectionRepo.accept(c.id,c.replacement,c.original).dictionaryId)
    await HistoryRepo.remove(f.id);assert.equal(f.candidates().total,0)
  })
  await test('beta.13 candidate schema migrates without losing pending history corrections',async()=>{
    closeDatabase();const legacy=join(dir,'legacy');initDatabase(legacy)
    await HistoryRepo.upsert({id:'legacy',status:'completed',mode:'voice_transcript',refinedText:original})
    CorrectionRepo.saveEdit('legacy',corrected,true);closeDatabase()
    const raw=new Database(join(legacy,'opentype.db'))
    raw.exec('ALTER TABLE correction_candidates DROP COLUMN source_kind; ALTER TABLE correction_candidates DROP COLUMN source_domains;');raw.close()
    initDatabase(legacy);const c=CorrectionRepo.list(0,'legacy').items
    assert.equal(c.length,2);assert(c.every(v=>v.sourceKind==='history_edit'))
    assert(CorrectionRepo.accept(c[0].id,c[0].replacement,c[0].original).dictionaryId)
    assert.equal((await HistoryRepo.byId('legacy'))?.editedText,corrected)
  })
  console.log(`${count} input correction scenarios passed`)
} finally {closeDatabase();rmSync(dir,{recursive:true,force:true})}
