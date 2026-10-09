import { app, BrowserWindow, ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { DictionaryRepo, getDictionarySyncStore } from '../db'
import { dictionaryAccountScope, parseDictionaryWord } from '../db/dictionary-sync'
import type { DictionaryMutationResult, DictionarySyncStatus } from '../../shared/dictionary-sync'
import { serviceRequest } from './network'
import { serviceEndpoint, serviceScope } from '../../shared/network-policy'

interface Session { generation:number;userId:string;server:string;scope:string;controller:AbortController }
/** Opt-in, account-scoped synchronization; every await checks the original identity. */
export class DictionarySync {
  private generation=0
  private active?:Session
  private timer?:ReturnType<typeof setTimeout>
  private poll:ReturnType<typeof setInterval>
  private phase:DictionarySyncStatus['phase']='idle'
  private detail?:string
  private disposed=false
  private suspended=false
  private failures=0
  private readonly store=getDictionarySyncStore()
  constructor(private deps:{account:()=>{userId:string;server:string}|null;token:()=>Promise<string|null>;busy:()=>boolean}){
    this.store.onChanged(()=>{if(!this.disposed){this.publish();this.schedule(1500)}})
    this.poll=setInterval(()=>this.schedule(0),60_000);this.poll.unref()
    this.refreshAccount()
  }
  private identity(){
    const account=this.deps.account();if(!account)return null
    try{const server=serviceScope(account.server);serviceEndpoint(server);return {...account,server,scope:dictionaryAccountScope(server,account.userId)}}catch{return null}
  }
  refreshAccount(){
    this.suspended=false
    this.generation++;this.active?.controller.abort();this.active=undefined;clearTimeout(this.timer)
    this.phase='idle';this.detail=undefined;this.failures=0
    const identity=this.identity(),account=identity?this.store.ensure(identity.server,identity.userId):undefined
    DictionaryRepo.setScope(account?.joined&&account.use_account?account.scope:'local')
    this.publish();this.schedule(500)
  }
  status():DictionarySyncStatus{
    const identity=this.suspended?null:this.identity(),account=identity?this.store.account(identity.scope):undefined
    return {account:!!identity,accountScope:identity?.scope,scope:DictionaryRepo.scope(),view:DictionaryRepo.scope()==='local'?'local':'account',enabled:account?.enabled===1,joined:account?.joined===1,
      phase:account?.enabled===1?this.phase:'disabled',detail:this.detail,...(identity?this.store.counts(identity.scope):{pending:0,conflicts:0}),lastSyncedAt:account?.last_synced_at??undefined}
  }
  private publish(){
    const status=this.status()
    for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed()){
      win.webContents.send('desktop:dictionary-sync-state',status)
      win.webContents.send('desktop:dictionary-changed')
    }
    return status
  }
  private schedule(delay:number){
    if(this.disposed||this.suspended||this.active)return
    const identity=this.identity();if(!identity||!this.store.account(identity.scope)?.enabled)return
    clearTimeout(this.timer);this.timer=setTimeout(()=>void this.synchronize(),delay);this.timer.unref()
  }
  private assert(session:Session){
    const identity=this.identity()
    if(this.disposed||this.suspended||session.controller.signal.aborted||session.generation!==this.generation||identity?.scope!==session.scope||!this.store.account(session.scope)?.enabled)throw new Error('session_changed')
  }
  private async post(session:Session,path:string,body:unknown){
    this.assert(session);const token=await this.deps.token();this.assert(session)
    if(!token)throw new Error('not_authenticated')
    const response=await serviceRequest(serviceEndpoint(session.server,path),{method:'POST',headers:{'content-type':'application/json','user-agent':`OpenType/${app.getVersion()}`,authorization:`Bearer ${token}`},
      body:JSON.stringify(body),signal:AbortSignal.any([session.controller.signal,AbortSignal.timeout(30_000)])})
    if(response.statusCode===404){await response.body.dump();this.assert(session);throw new Error('dictionary_sync_unsupported')}
    const payload=await response.body.json() as {status?:string;detail?:string;data?:any};this.assert(session)
    if(response.statusCode>=400||payload.status!=='OK')throw new Error(payload.detail??'dictionary_sync_failed')
    return payload.data
  }
  async synchronize(){
    const identity=this.identity()
    if(this.disposed||this.suspended||this.active||!identity||!this.store.account(identity.scope)?.enabled)return this.status()
    clearTimeout(this.timer)
    const session:Session={...identity,generation:this.generation,controller:new AbortController()};this.active=session;this.phase='syncing';this.detail=undefined;this.publish()
    try{
      const status=await this.post(session,'/user/dictionary/sync/status',{})
      if(status?.dictionary_sync_version!==1)throw new Error('dictionary_sync_unsupported')
      if(!Number.isSafeInteger(status.revision)||status.revision<0)throw new Error('dictionary_sync_invalid_response')
      // Pull before pushing so concurrent remote edits become visible conflicts.
      await this.pull(session)
      for(let page=0;page<1000;page++){
        this.assert(session);const mutations=this.store.pending(session.scope)
        if(!mutations.length)break
        const response=await this.post(session,'/user/dictionary/sync/push',{mutations})
        if(!Array.isArray(response?.results)||response.results.length!==mutations.length)throw new Error('dictionary_sync_invalid_response')
        const seen=new Set<string>()
        const results:DictionaryMutationResult[]=response.results.map((r:any)=>{
          const sent=mutations.find(m=>m.key===r?.key&&m.mutationId===r?.mutationId)
          if(!sent||!['accepted','conflict'].includes(r.status)||seen.has(r.key))throw new Error('dictionary_sync_invalid_response')
          seen.add(r.key);const word=parseDictionaryWord(r.word)
          if(word.key!==r.key)throw new Error('dictionary_sync_invalid_response')
          return {key:r.key,mutationId:r.mutationId,status:r.status,word}
        })
        this.assert(session);this.store.acknowledge(session.scope,mutations,results)
      }
      await this.pull(session);this.assert(session)
      this.store.markSynced(session.scope);this.phase='idle';this.failures=0
    }catch(error){
      if(this.active===session&&!session.controller.signal.aborted&&session.generation===this.generation){this.phase='error';this.detail=(error as Error).message;this.failures++}
    }finally{
      if(this.active===session){this.active=undefined;this.publish()
        if(this.phase==='error'&&this.failures<=5)this.schedule(Math.min(60_000,2000*2**this.failures))
        else if(this.store.pending(session.scope,1).length&&this.phase!=='error')this.schedule(1000)
      }
    }
    return this.status()
  }
  private async pull(session:Session){
    for(let page=0;page<1000;page++){
      this.assert(session);const cursor=this.store.account(session.scope)!.cursor
      const result=await this.post(session,'/user/dictionary/sync/pull',{cursor,limit:200})
      if(!Array.isArray(result?.words)||result.words.length>200||!Number.isSafeInteger(result.cursor)||result.cursor<cursor||typeof result.hasMore!=='boolean')throw new Error('dictionary_sync_invalid_response')
      const words=result.words.map(parseDictionaryWord)
      let previous=cursor;const keys=new Set<string>()
      for(const word of words){if(word.revision<=previous||keys.has(word.key))throw new Error('dictionary_sync_invalid_response');previous=word.revision;keys.add(word.key)}
      if(result.cursor!==previous||(result.hasMore&&!words.length))throw new Error('dictionary_sync_invalid_response')
      this.assert(session);this.store.applyPage(session.scope,words,result.cursor)
      if(!result.hasMore)return
    }
    throw new Error('dictionary_sync_retry_required')
  }
  private expectedAccount(expected?:string){
    const identity=this.identity()
    if(this.suspended||!identity)throw new Error('not_authenticated')
    if(expected!==undefined&&expected!==identity.scope)throw new Error('dictionary_scope_changed')
    return identity
  }
  configure(enabled:boolean,copyLocal=false,expected?:string){
    if(typeof enabled!=='boolean'||typeof copyLocal!=='boolean')throw new Error('invalid_config')
    if(!enabled&&copyLocal)throw new Error('invalid_config')
    const identity=this.expectedAccount(expected)
    if(enabled&&this.deps.busy())throw new Error('请先结束当前录音或文字处理，再切换词典')
    this.store.ensure(identity.server,identity.userId)
    this.store.configure(identity.scope,enabled,copyLocal)
    this.refreshAccount();return this.status()
  }
  selectView(view:'local'|'account',expected?:string){
    if(this.suspended)throw new Error('dictionary_scope_changed')
    if(!['local','account'].includes(view))throw new Error('invalid_config')
    if(this.deps.busy())throw new Error('请先结束当前录音或文字处理，再切换词典')
    const identity=this.identity(),account=identity?this.store.account(identity.scope):undefined
    if(expected!==undefined&&identity?.scope!==expected)throw new Error('dictionary_scope_changed')
    if(view==='account'&&!account?.joined)throw new Error('请先开启此账号的词典同步')
    if(account)this.store.view(account.scope,view==='account')
    DictionaryRepo.setScope(view==='account'?account!.scope:'local');return this.publish()
  }
  copyLocal(expected?:string){
    const identity=this.expectedAccount(expected);if(!this.store.account(identity.scope)?.joined)throw new Error('not_authenticated')
    const added=this.store.importLocal(identity.scope);this.publish();this.schedule(0);return {added}
  }
  rebuild(expected?:string){
    const identity=this.expectedAccount(expected)
    if(!this.store.account(identity.scope)?.joined)throw new Error('dictionary_scope_changed')
    if(this.deps.busy())throw new Error('请先结束当前录音或文字处理，再重新对齐词库')
    this.suspend()
    try{this.store.rebuild(identity.scope)}finally{this.refreshAccount()}
    return this.status()
  }
  conflicts(){const identity=this.suspended?null:this.identity();return identity?this.store.conflicts(identity.scope):[]}
  resolve(key:string,revision:number,choice:'local'|'remote',expected:string|undefined,mutationId:string){
    const identity=this.expectedAccount(expected)
    if(!['local','remote'].includes(choice))throw new Error('invalid_config')
    this.store.resolve(identity.scope,key,revision,choice,mutationId);this.publish();this.schedule(0)
  }
  suspend(){this.suspended=true;this.generation++;this.active?.controller.abort();this.active=undefined;clearTimeout(this.timer);DictionaryRepo.setScope('local');this.publish()}
  dispose(){this.disposed=true;this.generation++;this.active?.controller.abort();clearTimeout(this.timer);clearInterval(this.poll);this.store.onChanged(()=>{})}
}
export function registerDictionarySync(getService:()=>DictionarySync,owner:()=>WebContents|undefined){
  const authorize=(event:IpcMainInvokeEvent)=>{const expected=owner();if(!expected||event.sender!==expected||event.senderFrame!==expected.mainFrame)throw new Error('invalid_dictionary_request')}
  const handle=(channel:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(channel,(event,...args)=>{authorize(event);return fn(...args)})
  handle('desktop:dictionary-sync-status',()=>getService().status())
  handle('desktop:dictionary-sync-run',()=>getService().synchronize())
  handle('desktop:dictionary-sync-configure',(enabled,copyLocal,scope)=>getService().configure(enabled,copyLocal,scope))
  handle('desktop:dictionary-sync-view',(view,scope)=>getService().selectView(view,scope))
  handle('desktop:dictionary-sync-copy-local',scope=>getService().copyLocal(scope))
  handle('desktop:dictionary-sync-rebuild',scope=>getService().rebuild(scope))
  handle('desktop:dictionary-sync-conflicts',()=>getService().conflicts())
  handle('desktop:dictionary-sync-resolve',(key,revision,choice,scope,mutationId)=>getService().resolve(key,revision,choice,scope,mutationId))
}
