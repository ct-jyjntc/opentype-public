import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { DictionaryConflict, DictionaryMutation, DictionaryMutationResult, SyncedDictionaryValue, SyncedDictionaryWord } from '../../shared/dictionary-sync'
export const dictionaryTermKey=(term:string)=>createHash('sha256').update(term.normalize('NFC').trim().toLowerCase()).digest('hex')
export const dictionaryAccountScope=(server:string,userId:string)=>'sync:'+createHash('sha256').update(JSON.stringify([server,userId])).digest('hex')
interface Account { scope:string;server_url:string;user_id:string;enabled:number;joined:number;use_account:number;cursor:number;last_synced_at:string|null }
interface PendingRow { scope:string;word_key:string;mutation_id:string;base_revision:number;payload:string;remote_json:string|null }
const same=(a:SyncedDictionaryValue,b:SyncedDictionaryValue)=>a.deleted===b.deleted&&(a.deleted||(a.term===b.term&&(a.pronunciation??'')===(b.pronunciation??'')))
export function parseDictionaryWord(input:unknown):SyncedDictionaryWord {
  const w=input as SyncedDictionaryWord
  if(!w||typeof w.key!=='string'||!/^[a-f0-9]{64}$/.test(w.key)||!Number.isSafeInteger(w.revision)||w.revision<0||typeof w.deleted!=='boolean')throw new Error('dictionary_sync_invalid_response')
  if(w.deleted)return {key:w.key,revision:w.revision,deleted:true}
  if(typeof w.term!=='string'||!w.term.trim()||w.term.length>100||w.term!==w.term.normalize('NFC').trim()||dictionaryTermKey(w.term)!==w.key||typeof w.pronunciation!=='string'||w.pronunciation.length>100||w.revision===0)throw new Error('dictionary_sync_invalid_response')
  return {key:w.key,revision:w.revision,deleted:false,term:w.term,pronunciation:w.pronunciation}
}
export class DictionarySyncStore {
  private listener=()=>{}
  private notificationQueued=false
  constructor(private db:Database.Database){
    db.function('opentype_dictionary_key',{deterministic:true},value=>dictionaryTermKey(String(value)))
    db.function('opentype_dictionary_dirty',()=>{
      if(!this.notificationQueued){this.notificationQueued=true;queueMicrotask(()=>{this.notificationQueued=false;this.listener()})}
      return 0
    })
    db.exec(`CREATE TABLE IF NOT EXISTS dictionary_accounts (
      scope TEXT PRIMARY KEY,server_url TEXT NOT NULL,user_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
      joined INTEGER NOT NULL DEFAULT 0,use_account INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0,last_synced_at TEXT);
      CREATE TABLE IF NOT EXISTS dictionary_sync_base (scope TEXT NOT NULL,word_key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,word_key));
      CREATE TABLE IF NOT EXISTS dictionary_outbox (scope TEXT NOT NULL,word_key TEXT NOT NULL,mutation_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload TEXT NOT NULL,remote_json TEXT,PRIMARY KEY(scope,word_key));
      CREATE TABLE IF NOT EXISTS dictionary_sync_guard (id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL);
      INSERT OR IGNORE INTO dictionary_sync_guard VALUES (1,0);`)
    const enqueue=(scope:string,key:string,payload:string)=>`INSERT INTO dictionary_outbox(scope,word_key,mutation_id,base_revision,payload)
      VALUES (${scope},${key},lower(hex(randomblob(16))),coalesce((SELECT revision FROM dictionary_sync_base WHERE scope=${scope} AND word_key=${key}),0),${payload})
      ON CONFLICT(scope,word_key) DO UPDATE SET mutation_id=excluded.mutation_id,base_revision=excluded.base_revision,payload=excluded.payload;`
    const allowed="(SELECT active FROM dictionary_sync_guard WHERE id=1)=0"
    const data="json_object('deleted',json('false'),'term',NEW.term,'pronunciation',coalesce(NEW.pronunciation,''))"
    db.exec(`CREATE TRIGGER IF NOT EXISTS dictionary_sync_insert AFTER INSERT ON dictionary WHEN NEW.user_id LIKE 'sync:%' AND ${allowed} BEGIN
      ${enqueue('NEW.user_id','opentype_dictionary_key(NEW.term)',data)} SELECT opentype_dictionary_dirty(); END;
      CREATE TRIGGER IF NOT EXISTS dictionary_sync_update AFTER UPDATE OF term,pronunciation ON dictionary
      WHEN NEW.user_id LIKE 'sync:%' AND ${allowed} AND (OLD.term IS NOT NEW.term OR OLD.pronunciation IS NOT NEW.pronunciation) BEGIN
      ${enqueue('NEW.user_id','opentype_dictionary_key(NEW.term)',data)} SELECT opentype_dictionary_dirty(); END;
      CREATE TRIGGER IF NOT EXISTS dictionary_sync_rename AFTER UPDATE OF term ON dictionary
      WHEN OLD.user_id LIKE 'sync:%' AND ${allowed} AND opentype_dictionary_key(OLD.term)<>opentype_dictionary_key(NEW.term) BEGIN
      ${enqueue('OLD.user_id','opentype_dictionary_key(OLD.term)',"json_object('deleted',json('true'))")} SELECT opentype_dictionary_dirty(); END;
      CREATE TRIGGER IF NOT EXISTS dictionary_sync_delete AFTER DELETE ON dictionary WHEN OLD.user_id LIKE 'sync:%' AND ${allowed} BEGIN
      ${enqueue('OLD.user_id','opentype_dictionary_key(OLD.term)',"json_object('deleted',json('true'))")} SELECT opentype_dictionary_dirty(); END;`)
  }
  onChanged(listener:()=>void){this.listener=listener}
  account(scope:string){return this.db.prepare('SELECT * FROM dictionary_accounts WHERE scope=?').get(scope) as Account|undefined}
  ensure(server:string,userId:string){
    const scope=dictionaryAccountScope(server,userId)
    this.db.prepare('INSERT OR IGNORE INTO dictionary_accounts(scope,server_url,user_id) VALUES (?,?,?)').run(scope,server,userId)
    return this.account(scope)!
  }
  configure(scope:string,enabled:boolean,copyLocal=false){this.db.transaction(()=>{
    this.db.prepare('UPDATE dictionary_accounts SET enabled=?,use_account=CASE WHEN ?=1 OR joined=0 THEN 1 ELSE use_account END,joined=1 WHERE scope=?').run(enabled?1:0,enabled?1:0,scope)
    if(copyLocal)this.importLocal(scope)
  })()}
  view(scope:string,account:boolean){this.db.prepare('UPDATE dictionary_accounts SET use_account=? WHERE scope=? AND joined=1').run(account?1:0,scope)}
  counts(scope:string){
    const row=this.db.prepare('SELECT count(*) AS pending,sum(CASE WHEN remote_json IS NOT NULL THEN 1 ELSE 0 END) AS conflicts FROM dictionary_outbox WHERE scope=?').get(scope) as {pending:number;conflicts:number|null}
    return {pending:row.pending,conflicts:row.conflicts??0}
  }
  pending(scope:string,limit=200):DictionaryMutation[]{
    const rows=this.db.prepare('SELECT * FROM dictionary_outbox WHERE scope=? AND remote_json IS NULL ORDER BY word_key LIMIT ?').all(scope,limit) as PendingRow[]
    return rows.map(r=>({key:r.word_key,mutationId:r.mutation_id,baseRevision:r.base_revision,value:JSON.parse(r.payload)}))
  }
  conflicts(scope:string):DictionaryConflict[]{
    const rows=this.db.prepare('SELECT o.*,b.payload AS previous FROM dictionary_outbox o LEFT JOIN dictionary_sync_base b ON o.scope=b.scope AND o.word_key=b.word_key WHERE o.scope=? AND o.remote_json IS NOT NULL ORDER BY o.word_key LIMIT 500').all(scope) as (PendingRow&{previous?:string})[]
    return rows.map(r=>({key:r.word_key,mutationId:r.mutation_id,local:JSON.parse(r.payload),remote:JSON.parse(r.remote_json!),previous:r.previous?JSON.parse(r.previous):undefined}))
  }
  private base(scope:string,key:string){return this.db.prepare('SELECT revision,payload FROM dictionary_sync_base WHERE scope=? AND word_key=?').get(scope,key) as {revision:number;payload:string}|undefined}
  private saveBase(scope:string,word:SyncedDictionaryWord){this.db.prepare('INSERT INTO dictionary_sync_base(scope,word_key,revision,payload) VALUES (?,?,?,?) ON CONFLICT(scope,word_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(scope,word.key,word.revision,JSON.stringify(word))}
  private rebase(scope:string,word:SyncedDictionaryWord){
    this.saveBase(scope,word)
    this.db.prepare('UPDATE dictionary_outbox SET base_revision=?,mutation_id=?,remote_json=NULL WHERE scope=? AND word_key=?').run(word.revision,randomUUID(),scope,word.key)
  }
  private apply(scope:string,word:SyncedDictionaryWord){
    this.saveBase(scope,word)
    const rows=this.db.prepare('SELECT id FROM dictionary WHERE user_id=? AND opentype_dictionary_key(term)=? ORDER BY rowid').all(scope,word.key) as {id:string}[]
    if(word.deleted){this.db.prepare('DELETE FROM dictionary WHERE user_id=? AND opentype_dictionary_key(term)=?').run(scope,word.key);return}
    if(rows.length){
      for(const duplicate of rows.slice(1))this.db.prepare('DELETE FROM dictionary WHERE id=? AND user_id=?').run(duplicate.id,scope)
      this.db.prepare('UPDATE dictionary SET term=?,pronunciation=? WHERE id=? AND user_id=?').run(word.term!,word.pronunciation??'',rows[0].id,scope)
    }else this.db.prepare('INSERT INTO dictionary(id,user_id,term,pronunciation,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope,word.term!,word.pronunciation??'',new Date().toISOString())
  }
  private guarded<T>(work:()=>T){return this.db.transaction(()=>{this.db.prepare('UPDATE dictionary_sync_guard SET active=1 WHERE id=1').run();const result=work();this.db.prepare('UPDATE dictionary_sync_guard SET active=0 WHERE id=1').run();return result})()}
  applyPage(scope:string,words:SyncedDictionaryWord[],cursor:number){
    this.guarded(()=>{
      for(const word of words){
        const base=this.base(scope,word.key)
        if(base&&word.revision<=base.revision)continue
        const pending=this.db.prepare('SELECT * FROM dictionary_outbox WHERE scope=? AND word_key=?').get(scope,word.key) as PendingRow|undefined
        if(pending){
          const local=JSON.parse(pending.payload) as SyncedDictionaryValue
          if(same(local,word))this.db.prepare('DELETE FROM dictionary_outbox WHERE scope=? AND word_key=?').run(scope,word.key)
          else if(base&&same(JSON.parse(base.payload),word)){this.rebase(scope,word);continue}
          else{this.db.prepare('UPDATE dictionary_outbox SET remote_json=? WHERE scope=? AND word_key=?').run(JSON.stringify(word),scope,word.key);continue}
        }
        this.apply(scope,word)
      }
      this.db.prepare('UPDATE dictionary_accounts SET cursor=? WHERE scope=?').run(cursor,scope)
    })
  }
  acknowledge(scope:string,sent:DictionaryMutation[],results:DictionaryMutationResult[]){
    this.guarded(()=>{for(const result of results){
      const original=sent.find(m=>m.key===result.key&&m.mutationId===result.mutationId)
      if(!original)throw new Error('dictionary_sync_invalid_response')
      const pending=this.db.prepare('SELECT * FROM dictionary_outbox WHERE scope=? AND word_key=?').get(scope,result.key) as PendingRow|undefined
      if(!pending)continue
      if(result.status==='accepted'&&pending.mutation_id===original.mutationId){
        this.db.prepare('DELETE FROM dictionary_outbox WHERE scope=? AND word_key=?').run(scope,result.key);this.apply(scope,result.word)
      }else if(result.status==='accepted'&&same(result.word,original.value))this.rebase(scope,result.word)
      else if(same(JSON.parse(pending.payload),result.word)){
        this.db.prepare('DELETE FROM dictionary_outbox WHERE scope=? AND word_key=?').run(scope,result.key);this.apply(scope,result.word)
      }else this.db.prepare('UPDATE dictionary_outbox SET remote_json=? WHERE scope=? AND word_key=?').run(JSON.stringify(result.word),scope,result.key)
    }})
  }
  resolve(scope:string,key:string,revision:number,choice:'local'|'remote',mutationId:string){
    this.guarded(()=>{
      const pending=this.db.prepare('SELECT * FROM dictionary_outbox WHERE scope=? AND word_key=?').get(scope,key) as PendingRow|undefined
      if(!pending?.remote_json||pending.mutation_id!==mutationId)throw new Error('dictionary_conflict_changed')
      const remote=parseDictionaryWord(JSON.parse(pending.remote_json))
      if(remote.revision!==revision)throw new Error('dictionary_conflict_changed')
      if(choice==='local')this.rebase(scope,remote)
      else{this.db.prepare('DELETE FROM dictionary_outbox WHERE scope=? AND word_key=?').run(scope,key);this.apply(scope,remote)}
    })
    this.listener()
  }
  importLocal(scope:string){
    return this.db.transaction(()=>{
      const rows=this.db.prepare("SELECT term,pronunciation FROM dictionary WHERE user_id='local'").all() as {term:string;pronunciation:string|null}[]
      const keys=new Set((this.db.prepare('SELECT term FROM dictionary WHERE user_id=?').all(scope) as {term:string}[]).map(w=>dictionaryTermKey(w.term)))
      let added=0
      for(const row of rows){const term=row.term.normalize('NFC').trim(),key=dictionaryTermKey(term);if(keys.has(key))continue
        this.db.prepare('INSERT INTO dictionary(id,user_id,term,pronunciation,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope,term,row.pronunciation??'',new Date().toISOString());keys.add(key);added++}
      return added
    })()
  }
  markSynced(scope:string){this.db.prepare('UPDATE dictionary_accounts SET last_synced_at=? WHERE scope=?').run(new Date().toISOString(),scope)}
  rebuild(scope:string){
    this.db.transaction(()=>{
      // Recovery must preserve the entire outbox, including conflicts beyond
      // the UI's first page. It is not a paginated display operation.
      const pending=this.db.prepare('SELECT word_key,payload FROM dictionary_outbox WHERE scope=?').all(scope) as Pick<PendingRow,'word_key'|'payload'>[]
      const rows=this.db.prepare('SELECT term,pronunciation FROM dictionary WHERE user_id=?').all(scope) as {term:string;pronunciation:string|null}[]
      this.db.prepare('DELETE FROM dictionary_sync_base WHERE scope=?').run(scope)
      this.db.prepare('DELETE FROM dictionary_outbox WHERE scope=?').run(scope)
      const values=new Map<string,SyncedDictionaryValue>()
      for(const row of pending){const value=JSON.parse(row.payload) as SyncedDictionaryValue;if(value.deleted)values.set(row.word_key,{deleted:true})}
      for(const row of rows)values.set(dictionaryTermKey(row.term),{deleted:false,term:row.term,pronunciation:row.pronunciation??''})
      for(const [key,payload]of values)this.db.prepare('INSERT INTO dictionary_outbox(scope,word_key,mutation_id,base_revision,payload) VALUES (?,?,?,0,?)').run(scope,key,randomUUID(),JSON.stringify(payload))
      this.db.prepare('UPDATE dictionary_accounts SET cursor=0,last_synced_at=NULL WHERE scope=?').run(scope)
    })()
  }
}
