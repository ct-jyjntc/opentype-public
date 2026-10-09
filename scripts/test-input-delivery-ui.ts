// Interactive native bridge regression fixture. Operate only these disposable fields;
// no production profile, microphone, network, or arbitrary application capture.
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { AnswerCardSession } from '../src/main/services/answer-card'
import { CaptureSession } from '../src/main/services/capture-session'
import { capturedContext } from '../src/main/services/capture-context'
import { InputCorrections } from '../src/main/services/input-corrections'
import { initDatabase, closeDatabase, HistoryRepo, CorrectionRepo } from '../src/main/db'
import type { CardPayload } from '../src/shared/desktop'
import { deliverToInput, type InputSnapshot } from '../src/main/services/input-delivery'
mkdirSync('tmp/input-delivery',{recursive:true})
const dir=mkdtempSync(join(tmpdir(),'opentype-delivery-ui-'))
app.setPath('userData',dir);app.commandLine.appendSwitch('force-renderer-accessibility')
const windows=new Map<string,BrowserWindow>(),events:unknown[]=[]
let snapshot:InputSnapshot|undefined,busy=false
writeFileSync('tmp/input-delivery/ui-directory.txt',dir)
writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qa',{capture:mode=>ipcRenderer.send('qa:capture',mode),deliver:()=>ipcRenderer.send('qa:deliver'),show:n=>ipcRenderer.send('qa:show',n),onState:cb=>ipcRenderer.on('qa:state',(_,s)=>cb(s))})`)
writeFileSync(join(dir,'index.html'),readFileSync('scripts/fixtures/input-delivery.html','utf8'))
app.whenReady().then(async()=>{
  const {InputHelper,InputDelivery,InputObservation}=await import('../src/main/native/ffi')
  const report=(value:unknown)=>{events.push(value);for(const w of windows.values())if(!w.isDestroyed())w.webContents.send('qa:state',JSON.stringify(value));writeFileSync(resolve('tmp/input-delivery/ui-results.json'),JSON.stringify(events,null,2)+'\n')}
  if (process.argv.includes('--learning')) initDatabase(join(dir,'history.db'))
  const inputCorrections = new InputCorrections({native:{...InputObservation,read:token=>{const result=InputObservation.read(token);if(!result.active)report({action:'observation-stop',reason:result.reason});return result},release:token=>{InputObservation.release(token);report({action:'observation-ended'})}},enabled:()=>true,
    allowed:(id,text,target)=>CorrectionRepo.canObserve(id,text,[],target.inputWebDomains),
    save:(id,text,after,target)=>{const saved=CorrectionRepo.observeEdit(id,text,after,[],target.inputWebDomains);report({action:'input-corrections',...saved,items:CorrectionRepo.list(0,id).items});return saved.active}})
  let card: BrowserWindow | undefined, cardPayload: CardPayload | null = null
  const records = new Map<string, any>()
  const answers = new AnswerCardSession({
    show: payload => {
      cardPayload = payload
      report({action:'answer',canReplace:payload.canReplaceSelection,detail:payload.detail})
      if (!card || card.isDestroyed()) {
        card = new BrowserWindow({width:460,height:460,title:'OpenType 回答验证',show:false,webPreferences:{preload:resolve('dist/preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
        const current = card
        current.once('ready-to-show',()=>current.show())
        current.on('closed',()=>{if(card===current){answers.close();cardPayload=null;card=undefined}})
        void current.loadFile(resolve('dist/renderer/interactive-card.html'))
      } else { card.webContents.send('interactive-card:update',payload);card.show() }
    },
    release: token => InputHelper.releaseTarget(token),
    deliver: (token,text,signal) => deliverToInput(InputDelivery,{token},text,signal),
    validate: async payload => {if(!records.has(payload.audioId!))throw new Error('answer_record_changed')},
    saveDelivery: async (_payload,outcome) => {report({action:'answer-delivery',...outcome})},
  })
  ipcMain.handle('page:get-interactive-card-payload',()=>cardPayload)
  ipcMain.handle('page:close-interactive-card',()=>{answers.close();card?.close()})
  ipcMain.handle('clipboard:write-text',(_event,text)=>clipboard.writeText(text))
  ipcMain.handle('desktop:answer-replace-selection',(event,id)=>{
    if(event.sender!==card?.webContents || event.senderFrame!==card.webContents.mainFrame)throw new Error('answer_selection_expired')
    return answers.replace(id)
  })
  ipcMain.on('config:frontend-runtime',event=>{event.returnValue={cloudBaseUrl:'',appVersion:'test',provider:'local'}})
  const ask = async (captured: InputSnapshot) => {
    const session = new CaptureSession({
      provider:{name:'synthetic-answer',transcribe:async request=>{
        report({action:'question-request',selectedText:request.parameters?.selected_text,redacted:request.audioContext.redacted})
        return {success:true,text:'【回答测试】',rawText:'合成语音指令：解释或改写选中文字'}
      }},
      getConfig:()=>({mode:'voice_command',outputLanguage:'zh',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
      context:()=>capturedContext(captured,process.argv.includes('--blocked-parent')?['localhost']:[]),notify:()=>{},flush:async()=>{},saveAudio:async()=>'/synthetic/no-audio.wav',
      saveHistory:async row=>{records.set(row.id,{...records.get(row.id),...row})},loadHistory:async id=>records.get(id)??null,
      inject:async()=>{throw new Error('question must not auto-inject')},releaseTarget:target=>{if(target.inputToken)InputHelper.releaseTarget(target.inputToken)},
      showCard:(text,audioId,target)=>answers.present({text,audioId,title:'随便问',contextNotice:target.audioContext.redacted?'当前输入环境的文字未用于回答。':undefined},target.inputToken&&target.selectedText?{token:target.inputToken,selectedText:target.selectedText,appName:target.appName}:undefined),
      changed:()=>{},personalization:async()=>({}),
    })
    await session.onStart();session.pushAudio(new Float32Array(1600),16000,0);await session.onStop()
  }
  const dictate = async (captured: InputSnapshot) => {
    busy=true
    const session = new CaptureSession({provider:{name:'synthetic-dictation',transcribe:async()=>({success:true,text:'Please use Opentipe and SenceVoice today.',rawText:'Please use Opentipe and SenceVoice today.'})},
      getConfig:()=>({mode:'voice_transcript',outputLanguage:'zh',asrLanguage:'zh',autoInject:true,blacklistDomains:[],appVersion:'test'}),
      context:()=>capturedContext(captured,[]),notify:state=>{if(state.phase==='done'||state.phase==='error')report({action:'capture-result',phase:state.phase,detail:state.detail})},flush:async()=>{},saveAudio:async()=>'/synthetic/no-audio.wav',
      saveHistory:record=>HistoryRepo.upsert(record),loadHistory:id=>HistoryRepo.byId(id),
      inject:(text,target,signal)=>deliverToInput(InputDelivery,{token:target.inputToken},text,signal),
      observeInput:(id,text,target)=>{const observing=inputCorrections.start(id,text,target);report({action:'observation-started',observing,id});return observing},
      releaseTarget:target=>{if(target.inputToken)InputHelper.releaseTarget(target.inputToken)},showCard:()=>{},changed:()=>{},personalization:async()=>({})})
    try {await session.onStart();session.pushAudio(new Float32Array(1600),16000,0);await session.onStop()} finally {busy=false;session.dispose()}
  }
  app.on('will-quit',()=>{inputCorrections.stop();answers.close();if(process.argv.includes('--learning'))closeDatabase()})
  const capture = (pid: number, mode = 'dictation') => {
    if (busy) return
    const foreground = InputHelper.getCurrentInputState()?.pid
    if (foreground !== pid) { report({action:'capture',reason:'not_test_window',expectedPid:pid,foregroundPid:foreground}); return }
    inputCorrections.stop()
    if (snapshot?.token) InputHelper.releaseTarget(snapshot.token)
    snapshot = InputHelper.captureTarget(mode === 'command')
    report({action:'capture',mode,selectionReadOnly:snapshot.selectionReadOnly,contextRedacted:snapshot.contextRedacted,available:!!snapshot.token,reason:snapshot.reason,selectedText:snapshot.selectedText,hasContext:!!snapshot.contextText,role:snapshot.role,webUrl:snapshot.webUrl,webUrls:snapshot.webUrls})
    if (process.argv.includes('--answers') && mode === 'command') { const captured = snapshot; snapshot = undefined; void ask(captured) }
    if (process.argv.includes('--learning') && mode === 'dictation') { const captured = snapshot; snapshot = undefined; void dictate(captured) }
  }
  ipcMain.on('qa:show',(_e,name)=>windows.get(name)?.show())
  ipcMain.on('qa:capture',async (event, mode)=>{
    if(busy)return
    const ownWindow=BrowserWindow.fromWebContents(event.sender)
    if(!ownWindow || ![...windows.values()].includes(ownWindow))return
    ownWindow.show();app.focus({steal:true})
    await new Promise(resolve=>setTimeout(resolve,200))
    capture(process.pid, mode)
  })
  const deliver = async () => {
    if(busy||!snapshot)return;busy=true
    try{report({action:'delivery',...(await deliverToInput(InputDelivery,snapshot,'【听写成功】',new AbortController().signal))})}
    catch(e){report({action:'delivery',reason:(e as Error).message})}
    finally{if(snapshot.token)InputHelper.releaseTarget(snapshot.token);snapshot=undefined;busy=false}
  }
  ipcMain.on('qa:deliver', async event => {
    const ownWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownWindow || ![...windows.values()].includes(ownWindow)) return
    ownWindow.show(); app.focus({steal:true})
    await new Promise(resolve => setTimeout(resolve, 200))
    report({action:'delivery-start',fromTestProcess:InputHelper.getCurrentInputState()?.pid===process.pid})
    await deliver()
  })
  let webOrigin: string | undefined
  if (process.argv.includes('--web')) {
    const server = createServer((request,response)=>{
      response.setHeader('content-type','text/html; charset=utf-8')
      if (request.url?.startsWith('/frame')) {
        response.end(`<html><textarea aria-label="嵌入式输入框" style="width:95%;height:80px;font:22px system-ui">Frame selected text</textarea><script>document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='q'){e.preventDefault();parent.postMessage('qa:frame-question','http://localhost:'+location.port)}})</script></html>`)
      } else {
        const html = readFileSync(join(dir,'index.html'),'utf8')
        const frame = `<iframe title="跨来源测试编辑器" src="${webOrigin?.replace('localhost','127.0.0.1')}/frame" style="width:95%;height:125px"></iframe><script>window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&e.data==='qa:frame-question')qa.capture('command')})</script>`
        response.end(html.replace('<textarea aria-label="普通输入框">',frame+'<textarea aria-label="普通输入框">'))
      }
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    webOrigin = 'http://localhost:'+(server.address() as {port:number}).port
    app.on('will-quit',()=>server.close())
  }
  for(const [i,name]of ['A','B'].entries()){
    const w=new BrowserWindow({x:250+i*440,y:160,width:740,height:740,title:'OpenType 交付测试 '+name,webPreferences:{preload:join(dir,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
    windows.set(name,w);w.on('closed',()=>windows.delete(name));if(webOrigin)await w.loadURL(webOrigin+'/?label='+name);else await w.loadFile(join(dir,'index.html'),{query:{label:name}})
  }
  windows.get('A')?.show()
  if (process.argv.includes('--native')) {
    const bundle = resolve('node_modules/.cache/OpenType Native QA.app')
    mkdirSync(join(bundle,'Contents/MacOS'),{recursive:true})
    writeFileSync(join(bundle,'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.opentype.input-qa</string><key>CFBundleName</key><string>OpenType Native QA</string><key>CFBundleExecutable</key><string>InputQA</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    const binary = join(bundle,'Contents/MacOS/InputQA')
    execFileSync('swiftc',['scripts/native-input-delivery-fixture.swift','-o',binary])
    const native = spawn(binary,[dir,...(process.argv.includes('--simulate-correction')?['--simulate-correction']:[])],{stdio:'inherit'})
    let lastRequest = ''
    const watcher = watch(dir,(_event,name)=>{
      if (name !== 'native-request.json') return
      try {
        const request = JSON.parse(readFileSync(join(dir,name),'utf8'))
        if (request.pid !== native.pid || request.request === lastRequest) return
        lastRequest = request.request
        if (request.action === 'capture') capture(request.pid)
        else if (request.action === 'deliver') void deliver()
      } catch { /* Atomic file replacement may briefly remove the old inode. */ }
    })
    app.on('will-quit',()=>{watcher.close();native.kill()})
  }
})
app.on('window-all-closed',()=>app.quit())
