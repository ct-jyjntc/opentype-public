// Legacy dictionary endpoints share the revisioned store with device sync.
import { transaction } from '../db/index.ts'
import { dictionaryKey, dictionaryWord, dictionaryRows, prepareDictionary, resolveDictionaryId, writeDictionaryWord, renameDictionaryWord } from './dictionary-sync.ts'
const MAX_TERM_LENGTH=100
const BULK_IMPORT_MAX=5000
export const ERR_TOO_MANY_WORDS=10314
export interface DictWord { user_dictionary_id:string;term:string;pronunciation:string;auto:boolean;created_at:number;updated_at:number }
export interface ListOptions {offset:number;size:number;query?:string;auto?:boolean}
export interface PreviewItem {line:number;word:string;status:'ready'|'duplicate'|'invalid'}
const normalizeTerm=(value:unknown)=>typeof value==='string'&&value.normalize('NFC').trim().length>0&&value.normalize('NFC').trim().length<=MAX_TERM_LENGTH?value.normalize('NFC').trim():null
const toWord=(row:ReturnType<typeof dictionaryRows>[number]):DictWord=>({user_dictionary_id:row.legacy_id!,term:row.term!,pronunciation:row.pronunciation??'',auto:row.auto===1,created_at:row.created_at,updated_at:row.updated_at})
export function listWords(userId:string,options:ListOptions){
  const words=dictionaryRows(userId).filter(row=>(options.auto===undefined||options.auto===(row.auto===1))&&(!options.query||row.term!.toLowerCase().includes(options.query.toLowerCase()))).map(toWord)
  return {words:words.slice(options.offset,options.offset+options.size),total_count:words.length}
}
export function addWord(userId:string,termRaw:unknown):DictWord|{error:string}{
  const term=normalizeTerm(termRaw);if(!term)return {error:'invalid_term'}
  prepareDictionary(userId);const key=dictionaryKey(term)
  if(!dictionaryWord(userId,key).deleted)return {error:'word_exists'}
  transaction(()=>writeDictionaryWord(userId,key,{deleted:false,term,pronunciation:''}))
  return toWord(dictionaryRows(userId).find(row=>row.word_key===key)!)
}
export function updateWord(userId:string,id:unknown,termRaw:unknown):DictWord|{error:string}{
  if(typeof id!=='string'||!id)return {error:'user_dictionary_id_required'}
  const term=normalizeTerm(termRaw);if(!term)return {error:'invalid_term'}
  const oldKey=resolveDictionaryId(userId,id);if(!oldKey)return {error:'word_not_found'}
  const key=dictionaryKey(term),old=dictionaryWord(userId,oldKey)
  if(key!==oldKey&&!dictionaryWord(userId,key).deleted)return {error:'word_exists'}
  transaction(()=>renameDictionaryWord(userId,oldKey,key,{deleted:false,term,pronunciation:old.pronunciation??''}))
  return toWord(dictionaryRows(userId).find(row=>row.word_key===key)!)
}
export function deleteWord(userId:string,id:unknown):{success:true}|{error:string}{
  if(typeof id!=='string'||!id)return {error:'user_dictionary_id_required'}
  const key=resolveDictionaryId(userId,id)
  if(key)transaction(()=>writeDictionaryWord(userId,key,{deleted:true}))
  return {success:true}
}
export function batchDeleteWords(userId:string,ids:unknown):{deleted_count:number}|{error:string}{
  if(!Array.isArray(ids)||!ids.length||ids.length>5000)return {error:'user_dictionary_ids_required'}
  prepareDictionary(userId)
  const keys=[...new Set(ids.filter((id):id is string=>typeof id==='string').map(id=>resolveDictionaryId(userId,id)).filter((key):key is string=>!!key))]
  transaction(()=>{for(const key of keys)writeDictionaryWord(userId,key,{deleted:true})})
  return {deleted_count:keys.length}
}
export function previewBulkImport(userId:string,contentRaw:unknown):{results:PreviewItem[]}|{error:string;code?:number}{
  if(typeof contentRaw!=='string')return {error:'content_required'}
  const lines=contentRaw.split('\n').map(l=>l.trim()).filter(Boolean)
  if(!lines.length)return {error:'content_empty'}
  if(lines.length>BULK_IMPORT_MAX)return {error:'too_many_words',code:ERR_TOO_MANY_WORDS}
  prepareDictionary(userId);const seen=new Set<string>()
  return {results:lines.map((word,i)=>{
    const term=normalizeTerm(word);if(!term)return {line:i+1,word,status:'invalid'}
    const key=dictionaryKey(term),exists=seen.has(key)||!dictionaryWord(userId,key).deleted;seen.add(key)
    return {line:i+1,word:term,status:exists?'duplicate':'ready'}
  })}
}
export function bulkImport(userId:string,contentRaw:unknown):{imported_count:number;skipped_count:number}|{error:string;code?:number}{
  const preview=previewBulkImport(userId,contentRaw)
  if('error'in preview)return preview
  let imported=0,skipped=0
  transaction(()=>{for(const row of preview.results){
    if(row.status!=='ready'){skipped++;continue}
    writeDictionaryWord(userId,dictionaryKey(row.word),{deleted:false,term:row.word,pronunciation:''});imported++
  }})
  return {imported_count:imported,skipped_count:skipped}
}
