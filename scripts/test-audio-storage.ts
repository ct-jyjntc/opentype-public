import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, unlinkSync, utimesSync, lstatSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AudioStorageRepo, HistoryRepo, initDatabase, closeDatabase } from '../src/main/db'
import { AudioStorage } from '../src/main/services/audio-storage'
import { HistoryLifecycle, readStoredAudio } from '../src/main/services/history-lifecycle'
const DAY = 86400000
let passed = 0
async function test(name: string, fn: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture()
  try { await fn(f); passed++; console.log('OK '+name) }
  finally { closeDatabase(); rmSync(f.root,{recursive:true,force:true}) }
}
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'opentype-audio-storage-')), audio=join(root,'audio')
  mkdirSync(audio);initDatabase(join(root,'db'))
  const state={now:Date.now()+2*DAY,busy:false,writing:new Set<string>(),changes:0}
  const opts={isBusy:()=>state.busy,isWriting:(id:string)=>state.writing.has(id),changed:()=>{state.changes++},now:()=>state.now}
  const storage=new AudioStorage(audio,opts)
  const put=(name:string,content='synthetic audio')=>{writeFileSync(join(audio,name),content);return join(audio,name)}
  return {root,audio,state,opts,storage,put}
}
async function recycle(f: ReturnType<typeof fixture>, name='orphan.wav') {
  f.put(name)
  const s=await f.storage.scan(), item=s.candidates.find(r=>r.name===name)!
  assert(item)
  assert.equal(f.storage.act(s.token,[item.key],'recycle').completed,1)
  return item.key
}
await test('scan is read-only and protects history IDs, normalized aliases, tombstones, recent files and writers', async f=>{
  f.put('orphan.wav');f.put('owned.ogg');f.put('alias.webm');f.put('deleted.wav');f.put('recent.wav');f.put('writing.wav')
  await HistoryRepo.upsert({id:'OWNED',status:'failed'})
  await HistoryRepo.upsert({id:'other',audioLocalPath:join(f.audio,'x','..','alias.webm')})
  await HistoryRepo.remove('deleted');f.state.writing.add('writing')
  utimesSync(join(f.audio,'recent.wav'),new Date(f.state.now),new Date(f.state.now))
  const before=readdirSync(f.audio)
  const s=await f.storage.scan()
  assert.deepEqual(s.candidates.map(r=>r.name),['orphan.wav'])
  assert.equal(s.protectedFiles,4);assert.equal(s.recentFiles,1)
  assert.deepEqual(readdirSync(f.audio),before)
  assert.equal(AudioStorageRepo.entries().length,0)
})
await test('recent ctime protects newly copied old recordings even with an old modification date', async f=>{
  f.put('copied.wav');utimesSync(join(f.audio,'copied.wav'),new Date(0),new Date(0))
  f.state.now=Date.now()
  assert.equal((await f.storage.scan()).recentFiles,1)
})
await test('unrecognized names, directories, symlinks and hard links are never candidates',async f=>{
  const outside=join(f.root,'outside.wav');writeFileSync(outside,'keep')
  f.put('notes.txt');f.put('space name.wav');mkdirSync(join(f.audio,'directory.wav'))
  symlinkSync(outside,join(f.audio,'link.wav'));linkSync(outside,join(f.audio,'hard.wav'))
  const s=await f.storage.scan();assert.equal(s.candidates.length,0);assert.equal(s.unknownFiles,5)
  assert.equal(readFileSync(outside,'utf8'),'keep')
})
await test('preview reads the exact reviewed audio and public snapshots contain no filesystem paths or identity stamps',async f=>{
  f.put('preview.ogg','OggS synthetic bytes')
  const s=await f.storage.scan(),r=s.candidates[0]
  assert.deepEqual(Object.keys(r).sort(),['bytes','key','modifiedAt','name'])
  assert.equal(Buffer.from(await f.storage.preview(s.token,r.key)).toString(),'OggS synthetic bytes')
  writeFileSync(join(f.audio,r.name),'changed')
  await assert.rejects(f.storage.preview(s.token,r.key),/audio_storage_file_changed/)
})
await test('recycle survives database restart; recovery restores exact bytes as a local unrecognized history item',async f=>{
  const key=await recycle(f)
  assert(!readdirSync(f.audio).includes('orphan.wav'))
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
  closeDatabase();initDatabase(join(f.root,'db'))
  const next=new AudioStorage(f.audio,f.opts),s=await next.scan()
  assert.equal(s.recycled.length,1)
  assert.equal(next.act(s.token,[key],'recover').completed,1)
  assert.equal(readFileSync(join(f.audio,'orphan.wav'),'utf8'),'synthetic audio')
  const row=await HistoryRepo.byId('orphan')
  assert.equal(row?.status,'failed');assert.equal(row?.userId,null);assert.equal(row?.refinedText,null)
  assert.equal(row?.audioLocalPath,join(f.audio,'orphan.wav'))
  assert(JSON.parse(String(row?.modeMeta)).recovered_audio)
  assert(Date.now()-Date.parse(row!.createdAt!)<5000)
  assert.equal(AudioStorageRepo.entries().length,0)
  assert.equal((await next.scan()).candidates.length,0)
})
await test('recover directly from candidates keeps other formats protected and never invokes recognition',async f=>{
  f.put('recover.wav');f.put('recover.ogg')
  const s=await f.storage.scan(),r=s.candidates.find(r=>r.name==='recover.wav')!
  assert.equal(f.storage.act(s.token,[r.key],'recover').completed,1)
  assert.equal((await HistoryRepo.pendingSyncForApi('test-user',200)).length,0)
  assert.equal((await f.storage.scan()).protectedFiles,2)
  assert.equal(readdirSync(f.audio).length,2)
})
await test('review expires and forged, duplicate, wrong-action and absent selections make no mutations',async f=>{
  f.put('old.wav');const s=await f.storage.scan(),key=s.candidates[0].key
  for(const [token,keys,action] of [[s.token,[key,key],'recycle'],[s.token,['../outside'],'recycle'],[s.token,[key],'erase'],['forged',[key],'recover'],[s.token,[],'recycle']] as const){
    assert.throws(()=>f.storage.act(token,[...keys],action),/audio_storage_/)
  }
  f.state.now+=11*60000
  assert.throws(()=>f.storage.act(s.token,[key],'recycle'),/review_expired/)
  assert.equal(readFileSync(join(f.audio,'old.wav'),'utf8'),'synthetic audio')
  assert.equal(AudioStorageRepo.entries().length,0)
})
await test('file changes and replacements after review stop the entire request before any move',async f=>{
  f.put('a.wav');f.put('b.wav');const s=await f.storage.scan()
  const old=lstatSync(join(f.audio,'b.wav'));unlinkSync(join(f.audio,'b.wav'));writeFileSync(join(f.audio,'b.wav'),'synthetic audio');utimesSync(join(f.audio,'b.wav'),old.atime,old.mtime)
  assert.throws(()=>f.storage.act(s.token,s.candidates.map(f=>f.key),'recycle'),/file_changed/)
  assert.equal(AudioStorageRepo.entries().length,0)
  assert(readdirSync(f.audio).includes('a.wav'))
})
await test('new ownership, active recording and in-flight audio writes invalidate an earlier cleanup plan',async f=>{
  f.put('claimed.wav');let s=await f.storage.scan()
  await HistoryRepo.upsert({id:'claimed',status:'completed',refinedText:'keep me'})
  assert.equal(f.storage.act(s.token,[s.candidates[0].key],'recycle').failed[0].detail,'audio_storage_referenced')
  f.put('busy.wav');s=await f.storage.scan();f.state.busy=true
  assert.throws(()=>f.storage.act(s.token,[s.candidates[0].key],'recycle'),/audio_storage_busy/)
  f.state.busy=false;f.state.writing.add('busy')
  assert.equal(f.storage.act(s.token,[s.candidates[0].key],'recycle').completed,0)
  assert(readdirSync(f.audio).includes('busy.wav'))
})
await test('pending move retries after filesystem failure and process restart without losing original bytes',async f=>{
  f.put('retry.wav');const failed=new AudioStorage(f.audio,{...f.opts,rename:()=>{throw new Error('synthetic access denied')}})
  const s=await failed.scan(),key=s.candidates[0].key
  assert.equal(failed.act(s.token,[key],'recycle').completed,0)
  assert.equal(AudioStorageRepo.entries().length,1)
  assert.equal(readFileSync(join(f.audio,'retry.wav'),'utf8'),'synthetic audio')
  closeDatabase();initDatabase(join(f.root,'db'))
  const next=new AudioStorage(f.audio,f.opts),snapshot=await next.scan()
  assert.equal(snapshot.recycled.length,1);assert.equal(snapshot.unresolvedItems,0)
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
})
await test('crash between rename and journal acknowledgement recovers the already moved file',async f=>{
  f.put('crash.wav');const save=AudioStorageRepo.save
  AudioStorageRepo.save=(key,payload)=>{if(JSON.parse(payload).phase==='recycled')throw new Error('synthetic database failure');save(key,payload)}
  try {const s=await f.storage.scan();assert.equal(f.storage.act(s.token,[s.candidates[0].key],'recycle').completed,0)}finally{AudioStorageRepo.save=save}
  closeDatabase();initDatabase(join(f.root,'db'))
  assert.equal((await new AudioStorage(f.audio,f.opts).scan()).recycled.length,1)
})
await test('failed restoration after hard-link creation finishes on restart without overwriting original data',async f=>{
  const key=await recycle(f)
  const failed=new AudioStorage(f.audio,{...f.opts,unlink:()=>{throw new Error('synthetic unlink failure')}})
  const s=await failed.scan();assert.equal(failed.act(s.token,[key],'restore').completed,0)
  assert.equal(readFileSync(join(f.audio,'orphan.wav'),'utf8'),'synthetic audio')
  closeDatabase();initDatabase(join(f.root,'db'))
  const restored=await new AudioStorage(f.audio,f.opts).scan()
  assert.equal(restored.unresolvedItems,0);assert.equal(restored.recycled.length,0)
  assert.equal(AudioStorageRepo.entries().length,0);assert.equal(lstatSync(join(f.audio,'orphan.wav')).nlink,1)
})
await test('restore conflict keeps both versions and never overwrites an occupied original filename',async f=>{
  const key=await recycle(f);f.put('orphan.wav','newer unrelated file')
  const s=await f.storage.scan();assert.equal(f.storage.act(s.token,[key],'recover').failed[0].detail,'audio_storage_conflict')
  assert.equal(readFileSync(join(f.audio,'orphan.wav'),'utf8'),'newer unrelated file')
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
  assert.equal((await f.storage.scan()).unresolvedItems,1)
})
await test('permanent deletion is limited to reviewed recycled files; permission failure remains retryable',async f=>{
  const key=await recycle(f);f.put('unselected.wav','keep')
  const failed=new AudioStorage(f.audio,{...f.opts,unlink:()=>{throw new Error('synthetic permission failure')}})
  const s=await failed.scan();assert.equal(failed.act(s.token,[key],'erase').completed,0)
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
  closeDatabase();initDatabase(join(f.root,'db'))
  const retry = new AudioStorage(f.audio,f.opts), reviewed = await retry.scan()
  assert.equal(reviewed.recycled.length,1)
  assert.equal(retry.act(reviewed.token,[key],'erase').completed,1)
  assert.equal(readFileSync(join(f.audio,'unselected.wav'),'utf8'),'keep')
})
await test('new references stop pending recycle or permanent deletion after restart',async f=>{
  f.put('now-owned.wav');const failed=new AudioStorage(f.audio,{...f.opts,rename:()=>{throw new Error('fail')}})
  let s=await failed.scan();failed.act(s.token,[s.candidates[0].key],'recycle')
  await HistoryRepo.upsert({id:'now-owned',status:'completed',refinedText:'keep'})
  s=await f.storage.scan();assert.equal(s.recycled.length,0);assert.equal(AudioStorageRepo.entries().length,0)
  const key=await recycle(f);const failedErase=new AudioStorage(f.audio,{...f.opts,unlink:()=>{throw new Error('fail')}})
  s=await failedErase.scan();failedErase.act(s.token,[key],'erase')
  await HistoryRepo.upsert({id:'orphan',status:'completed',refinedText:'keep'})
  assert.equal((await f.storage.scan()).recycled.length,1)
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
})
await test('recycle directory replacement and forged journal paths cannot touch external files',async f=>{
  const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.wav'),'keep')
  symlinkSync(outside,join(f.audio,'.recycle'))
  await assert.rejects(f.storage.scan(),/unsafe_directory/)
  unlinkSync(join(f.audio,'.recycle'))
  AudioStorageRepo.save('fake-key',JSON.stringify({name:'../outside/keep.wav',phase:'erasing',stamp:{}}))
  assert.equal((await f.storage.scan()).unresolvedItems,1)
  assert.equal(readFileSync(join(outside,'keep.wav'),'utf8'),'keep')
})
await test('bounded review pages allow 215 orphans to be processed without omitting the remainder',async f=>{
  for(let i=0;i<215;i++)f.put(`batch-${i}.wav`)
  let s=await f.storage.scan();assert.equal(s.candidates.length,200);assert(s.truncated)
  assert.equal(f.storage.act(s.token,s.candidates.map(r=>r.key),'recycle').completed,200)
  s=await f.storage.scan();assert.equal(s.candidates.length,15)
  assert.equal(f.storage.act(s.token,s.candidates.map(r=>r.key),'recycle').completed,15)
  s=await f.storage.scan();assert.equal(s.recycled.length,200);assert(s.truncated)
  assert.equal(f.storage.act(s.token,s.recycled.map(r=>r.key),'erase').completed,200)
  s=await f.storage.scan();assert.equal(s.recycled.length,15)
  assert.equal(f.storage.act(s.token,s.recycled.map(r=>r.key),'erase').completed,15)
  assert.equal((await f.storage.scan()).recycled.length,0)
})
await test('actual HistoryLifecycle writer registration prevents storage selection during delayed I/O',async f=>{
  let release!:()=>void
  const wait=new Promise<void>(r=>{release=r})
  const life=new HistoryLifecycle(f.audio,()=>{},()=>{},async p=>unlinkSync(p),async(p,b)=>{await wait;writeFileSync(p,b)})
  f.put('writer.wav')
  const next=new AudioStorage(f.audio,{...f.opts,isWriting:id=>life.isWriting(id)})
  const writing=life.saveAudio('writer','wav',Buffer.from('new bytes'))
  assert(life.isWriting('writer'));assert.equal((await next.scan()).candidates.length,0)
  release();await writing;assert(!life.isWriting('writer'))
  assert.equal(readFileSync(join(f.audio,'writer.wav'),'utf8'),'new bytes')
})
await test('a blocked pending erase remains selectable for restoring a newly referenced recording',async f=>{
  const key=await recycle(f)
  const failed=new AudioStorage(f.audio,{...f.opts,unlink:()=>{throw new Error('permission failure')}})
  let s=await failed.scan();failed.act(s.token,[key],'erase')
  await HistoryRepo.upsert({id:'orphan',status:'completed',refinedText:'new history reference'})
  s=await f.storage.scan();assert.equal(s.recycled.length,1)
  assert.equal(f.storage.act(s.token,[key],'restore').completed,1)
  assert.equal(readFileSync(join(f.audio,'orphan.wav'),'utf8'),'synthetic audio')
  assert.equal((await HistoryRepo.byId('orphan'))?.refinedText,'new history reference')
})
await test('pending restoration waits for a registered writer and later restores without clobbering it',async f=>{
  const key=await recycle(f)
  const failed=new AudioStorage(f.audio,{...f.opts,link:()=>{throw new Error('link unavailable')}})
  const s=await failed.scan();failed.act(s.token,[key],'restore')
  f.state.writing.add('orphan')
  assert.equal((await f.storage.scan()).unresolvedItems,1)
  assert(!readdirSync(f.audio).includes('orphan.wav'))
  f.state.writing.clear()
  assert.equal((await f.storage.scan()).unresolvedItems,0)
  assert.equal(readFileSync(join(f.audio,'orphan.wav'),'utf8'),'synthetic audio')
})
await test('large preview is refused while recovery remains available without an audio duration cap',async f=>{
  const file=f.put('large.wav');truncateSync(file,33*1024*1024)
  const s=await f.storage.scan(),key=s.candidates[0].key
  await assert.rejects(f.storage.preview(s.token,key),/audio_storage_preview_large/)
  assert.equal(f.storage.act(s.token,[key],'recover').completed,1)
  assert.equal(lstatSync(file).size,33*1024*1024)
})
await test('a history reference to the exact recycle path prevents permanent removal',async f=>{
  const key=await recycle(f)
  await HistoryRepo.upsert({id:'alias-owner',status:'completed',audioLocalPath:join(f.audio,'.recycle',key)})
  const s=await f.storage.scan()
  assert.equal(f.storage.act(s.token,[key],'erase').failed[0].detail,'audio_storage_referenced')
  assert.equal(readFileSync(join(f.audio,'.recycle',key),'utf8'),'synthetic audio')
})
await test('recovering a chosen format also makes playback/export/retry read that exact owned file',async f=>{
  f.put('formats.wav','selected WAV');f.put('formats.ogg','other Ogg')
  const s=await f.storage.scan(),item=s.candidates.find(r=>r.name==='formats.wav')!
  assert.equal(f.storage.act(s.token,[item.key],'recover').completed,1)
  assert.equal((await readStoredAudio(f.audio,'formats'))?.toString(),'selected WAV')
  unlinkSync(join(f.audio,'formats.wav'))
  assert.equal(await readStoredAudio(f.audio,'formats'),null)
  f.put('formats.wav','selected WAV')
  const outside=join(f.root,'private.wav');writeFileSync(outside,'do not read')
  await HistoryRepo.setAudioPath('formats',outside)
  assert.equal((await readStoredAudio(f.audio,'formats'))?.toString(),'other Ogg')
  await HistoryRepo.remove('formats')
  assert.equal(await readStoredAudio(f.audio,'formats'),null)
  symlinkSync(outside,join(f.audio,'linked-target.wav'))
  await assert.rejects(readStoredAudio(f.audio,'linked-target'))
  assert.equal(readFileSync(outside,'utf8'),'do not read')
})
console.log(`${passed} audio storage scenarios passed`)
