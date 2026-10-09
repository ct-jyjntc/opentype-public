import { createHash, randomUUID } from 'node:crypto'
import { getDb, transaction } from '../db/index.ts'

export interface DictionaryValue { deleted: boolean; term?: string; pronunciation?: string }
export interface DictionaryWord extends DictionaryValue { key: string; revision: number }
interface Row { user_id:string; word_key:string; term:string|null; pronunciation:string|null; deleted:number; revision:number; created_at:number; updated_at:number; legacy_id:string|null; auto:number }
const keyFor = (term:string) => createHash('sha256').update(term.normalize('NFC').trim().toLowerCase()).digest('hex')
const value = (row:Row):DictionaryWord => ({key:row.word_key,revision:row.revision,deleted:row.deleted===1,...(row.deleted?{}:{term:row.term!,pronunciation:row.pronunciation??''})})
const equal = (a:DictionaryValue,b:DictionaryValue) => a.deleted===b.deleted && (a.deleted || (a.term===b.term && (a.pronunciation??'')===(b.pronunciation??'')))
export const dictionaryKey = keyFor
export function dictionaryWord(userId:string,key:string):DictionaryWord {
  const row=getDb().prepare('SELECT * FROM dictionary_sync_words WHERE user_id=? AND word_key=?').get(userId,key) as unknown as Row|undefined
  return row?value(row):{key,revision:0,deleted:true}
}
function nextRevision(userId:string) {
  const db=getDb()
  db.prepare('INSERT INTO dictionary_sync_meta(user_id,revision) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(userId)
  return Number((db.prepare('SELECT revision FROM dictionary_sync_meta WHERE user_id=?').get(userId) as {revision:number}).revision)
}
/** All callers already own a transaction. A tombstone contains no term or hint. */
export function writeDictionaryWord(userId:string,key:string,next:DictionaryValue,legacyId?:string):DictionaryWord {
  const db=getDb(),revision=nextRevision(userId),now=Date.now()
  const previous=db.prepare('SELECT legacy_id,deleted FROM dictionary_sync_words WHERE user_id=? AND word_key=?').get(userId,key) as {legacy_id:string|null;deleted:number}|undefined
  const identity=legacyId??(!previous?.deleted?previous?.legacy_id:null)??randomUUID()
  db.prepare(`INSERT INTO dictionary_sync_words(user_id,word_key,term,pronunciation,deleted,revision,created_at,updated_at,legacy_id)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,word_key) DO UPDATE SET term=excluded.term,pronunciation=excluded.pronunciation,
    deleted=excluded.deleted,revision=excluded.revision,updated_at=excluded.updated_at,legacy_id=excluded.legacy_id`).run(userId,key,next.deleted?null:next.term!,next.deleted?null:next.pronunciation??'',next.deleted?1:0,revision,now,now,identity)
  if(next.deleted)db.prepare('UPDATE dictionary_legacy_ids SET word_key=NULL WHERE user_id=? AND word_key=?').run(userId,key)
  else db.prepare('INSERT INTO dictionary_legacy_ids(user_id,legacy_id,word_key) VALUES (?,?,?) ON CONFLICT(user_id,legacy_id) DO UPDATE SET word_key=excluded.word_key').run(userId,identity,key)
  return {key,revision,...next}
}
/** Move every published identity with a rename, inside the caller's transaction. */
export function renameDictionaryWord(userId:string,oldKey:string,key:string,next:DictionaryValue) {
  if(oldKey===key)return writeDictionaryWord(userId,key,next)
  const db=getDb(),row=db.prepare('SELECT * FROM dictionary_sync_words WHERE user_id=? AND word_key=? AND deleted=0').get(userId,oldKey) as unknown as Row|undefined
  if(!row)throw new Error('word_not_found')
  const aliases=db.prepare('SELECT legacy_id FROM dictionary_legacy_ids WHERE user_id=? AND word_key=?').all(userId,oldKey) as {legacy_id:string}[]
  writeDictionaryWord(userId,oldKey,{deleted:true})
  const result=writeDictionaryWord(userId,key,next,row.legacy_id??undefined)
  db.prepare('UPDATE dictionary_sync_words SET created_at=?,auto=? WHERE user_id=? AND word_key=?').run(row.created_at,row.auto,userId,key)
  for(const alias of aliases)db.prepare('UPDATE dictionary_legacy_ids SET word_key=? WHERE user_id=? AND legacy_id=?').run(key,userId,alias.legacy_id)
  return result
}
/** Import the old account dictionary once, without depending on client clocks. */
export function prepareDictionary(userId:string) {
  const db=getDb()
  const meta=db.prepare('SELECT migrated,legacy_ids_migrated FROM dictionary_sync_meta WHERE user_id=?').get(userId) as {migrated:number;legacy_ids_migrated:number}|undefined
  if(meta?.migrated&&meta.legacy_ids_migrated)return
  transaction(()=>{
    const rows=meta?.migrated?[]:db.prepare('SELECT user_dictionary_id,term,auto,created_at,updated_at FROM dictionary_words WHERE user_id=? ORDER BY updated_at,user_dictionary_id').all(userId) as unknown as {user_dictionary_id:string;term:string;auto:number;created_at:number}[]
    for(const row of rows){
      const term=row.term.normalize('NFC').trim()
      if(term&&term.length<=100){
        writeDictionaryWord(userId,keyFor(term),{deleted:false,term,pronunciation:''},row.user_dictionary_id)
        db.prepare('UPDATE dictionary_sync_words SET auto=?,created_at=? WHERE user_id=? AND word_key=?').run(row.auto,row.created_at,userId,keyFor(term))
      }
    }
    // Earlier releases exposed either the original UUID or the content hash.
    // Preserve both once; never rebind a deleted alias to a later incarnation.
    if(!meta?.legacy_ids_migrated){
      const existing=db.prepare('SELECT * FROM dictionary_sync_words WHERE user_id=?').all(userId) as unknown as Row[]
      for(const row of existing){
        const identity=row.legacy_id??row.word_key
        db.prepare('UPDATE dictionary_sync_words SET legacy_id=? WHERE user_id=? AND word_key=?').run(identity,userId,row.word_key)
        for(const alias of new Set([identity,row.word_key]))db.prepare('INSERT OR IGNORE INTO dictionary_legacy_ids(user_id,legacy_id,word_key) VALUES (?,?,?)').run(userId,alias,row.deleted?null:row.word_key)
      }
    }
    db.prepare('INSERT INTO dictionary_sync_meta(user_id,revision,migrated,legacy_ids_migrated) VALUES (?,0,1,1) ON CONFLICT(user_id) DO UPDATE SET migrated=1,legacy_ids_migrated=1').run(userId)
    db.prepare('DELETE FROM dictionary_words WHERE user_id=?').run(userId)
  })
}
export function dictionaryStatus(userId:string) {
  prepareDictionary(userId)
  return {dictionary_sync_version:1,revision:Number((getDb().prepare('SELECT revision FROM dictionary_sync_meta WHERE user_id=?').get(userId) as {revision:number}).revision)}
}
export function pullDictionary(userId:string,cursor:unknown,limit:unknown=200) {
  prepareDictionary(userId)
  if(typeof cursor!=='number'||!Number.isSafeInteger(cursor)||cursor<0)throw new Error('invalid_dictionary_cursor')
  const size=typeof limit==='number'&&Number.isSafeInteger(limit)?Math.min(500,Math.max(1,limit)):200
  const revision=dictionaryStatus(userId).revision
  if(cursor>revision)throw new Error('dictionary_cursor_ahead')
  const rows=getDb().prepare('SELECT * FROM dictionary_sync_words WHERE user_id=? AND revision>? ORDER BY revision LIMIT ?').all(userId,cursor,size+1) as unknown as Row[]
  const page=rows.slice(0,size)
  return {words:page.map(value),cursor:page.at(-1)?.revision??cursor,hasMore:rows.length>size}
}
export function pushDictionary(userId:string,raw:unknown) {
  prepareDictionary(userId)
  if(!Array.isArray(raw)||raw.length>200)throw new Error('invalid_dictionary_mutations')
  const seen=new Set<string>()
  const mutations=raw.map((m:any)=>{
    if(!m||typeof m.key!=='string'||!/^[a-f0-9]{64}$/.test(m.key)||typeof m.mutationId!=='string'||! /^[\w-]{16,100}$/.test(m.mutationId)
      ||!Number.isSafeInteger(m.baseRevision)||m.baseRevision<0||!m.value||typeof m.value.deleted!=='boolean'||seen.has(m.key))throw new Error('invalid_dictionary_mutations')
    seen.add(m.key)
    const next:DictionaryValue=m.value.deleted?{deleted:true}:{deleted:false,term:m.value.term,pronunciation:m.value.pronunciation??''}
    if(!next.deleted&&(typeof next.term!=='string'||!next.term.trim()||next.term.length>100||next.term!==next.term.normalize('NFC').trim()
      ||typeof next.pronunciation!=='string'||next.pronunciation.length>100||keyFor(next.term)!==m.key))throw new Error('invalid_dictionary_mutations')
    return {key:m.key,mutationId:m.mutationId,baseRevision:m.baseRevision,value:next}
  })
  return transaction(()=>{
    const db=getDb(),results=[]
    for(const m of mutations){
      const fingerprint=createHash('sha256').update(JSON.stringify(m)).digest('hex')
      const receipt=db.prepare('SELECT request_hash FROM dictionary_sync_receipts WHERE user_id=? AND mutation_id=?').get(userId,m.mutationId) as {request_hash:string}|undefined
      if(receipt&&receipt.request_hash!==fingerprint)throw new Error('dictionary_mutation_reused')
      let word=dictionaryWord(userId,m.key)
      if(receipt){results.push({key:m.key,mutationId:m.mutationId,status:'accepted',word});continue}
      if(word.revision!==m.baseRevision&&!equal(word,m.value)){
        results.push({key:m.key,mutationId:m.mutationId,status:'conflict',word});continue
      }
      if(!equal(word,m.value)||(word.revision===0&&m.value.deleted))word=writeDictionaryWord(userId,m.key,m.value)
      db.prepare('INSERT INTO dictionary_sync_receipts(user_id,mutation_id,request_hash) VALUES (?,?,?)').run(userId,m.mutationId,fingerprint)
      results.push({key:m.key,mutationId:m.mutationId,status:'accepted',word})
    }
    return {results}
  })
}
export function dictionaryRows(userId:string) {
  prepareDictionary(userId)
  return getDb().prepare('SELECT * FROM dictionary_sync_words WHERE user_id=? AND deleted=0 ORDER BY updated_at DESC,word_key').all(userId) as unknown as Row[]
}
export function resolveDictionaryId(userId:string,id:string) {
  prepareDictionary(userId)
  const row=getDb().prepare('SELECT words.word_key FROM dictionary_legacy_ids AS ids JOIN dictionary_sync_words AS words ON words.user_id=ids.user_id AND words.word_key=ids.word_key WHERE ids.user_id=? AND ids.legacy_id=? AND words.deleted=0').get(userId,id) as {word_key:string}|undefined
  return row?.word_key
}
