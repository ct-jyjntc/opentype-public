// Actual renderer, preload, storage IPC and SQLite, with a controlled age clock.
// All samples belong to this temporary fixture. No real user data or microphone.
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { initDatabase, closeDatabase, HistoryRepo, AudioStorageRepo } from '../src/main/db'
import { AudioStorage } from '../src/main/services/audio-storage'
import { registerAudioStorage } from '../src/main/services/audio-storage-ipc'
import { registerDesktop } from '../src/main/services/desktop'
import { encodeWav } from '../src/main/services/pcm'
const root=process.env.OPENTYPE_STORAGE_UI_DIR || mkdtempSync(join(tmpdir(),'opentype-storage-ui-'))
if(!root.includes('opentype-storage-ui-'))throw new Error('isolated fixture required')
mkdirSync('tmp/audio-storage',{recursive:true});writeFileSync('tmp/audio-storage/ui-directory.txt',root)
app.setPath('userData',root);app.commandLine.appendSwitch('force-renderer-accessibility')
app.whenReady().then(async()=>{
  const audioDir=join(root,'audio');mkdirSync(audioDir,{recursive:true});initDatabase(join(root,'db'))
  const now=Date.now()+2*86400000
  const samples=Float32Array.from({length:8000},(_,i)=>Math.sin(i/16000*2*Math.PI*440)*0.03), wav=encodeWav([samples],16000)
  if(!existsSync(join(root,'seeded'))){
    for(const name of ['find-me.wav','keep-recycled.wav','erase-me.wav','linked.wav','recent.wav']){
      writeFileSync(join(audioDir,name),wav)
      utimesSync(join(audioDir,name),new Date(Date.now()-2*86400000),new Date(Date.now()-2*86400000))
    }
    utimesSync(join(audioDir,'recent.wav'),new Date(now),new Date(now))
    writeFileSync(join(audioDir,'notes.txt'),'unrelated file preserved')
    await HistoryRepo.upsert({id:'linked',status:'completed',refinedText:'这是一条正常历史，请保留它和录音。',audioLocalPath:join(audioDir,'linked.wav'),createdAt:new Date().toISOString()})
    writeFileSync(join(root,'seeded'),'synthetic fixture only')
  }
  const window=new BrowserWindow({width:1080,height:760,title:'OpenType 录音存储验证',webPreferences:{preload:resolve('dist/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const changed=()=>window.webContents.send('desktop:history-changed')
  const storage=new AudioStorage(audioDir,{isBusy:()=>false,isWriting:()=>false,changed,now:()=>now})
  registerAudioStorage(()=>storage,()=>window.webContents)
  registerDesktop({getPreferences:()=>({featureShortcutBindings:{dictationMode:['F8']},appearance:'light'}),savePreferences:()=>{},reloadShortcuts:()=>{},completeOnboarding:()=>{},
    audio:async id=>existsSync(join(audioDir,id+'.wav'))?readFileSync(join(audioDir,id+'.wav')):null,
    voice:async()=>({success:true,refine_text:'合成测试：找回的录音可以重新识别。',raw_text:'合成测试：找回的录音可以重新识别。'}),
    importCsv:async()=>({success:false,reason:'not part of storage test'}),changed})
  ipcMain.handle('config:get',()=>({hasOnboarded:true,historyRetentionDays:90,enableRefine:false,provider:'local',cloudBaseUrl:''}))
  ipcMain.on('config:frontend-runtime',event=>{event.returnValue={cloudBaseUrl:'',appVersion:app.getVersion(),provider:'local'}})
  ipcMain.handle('config:set',()=>{})
  ipcMain.handle('device:get-permissions',()=>({microphone:'denied',accessibility:false}))
  ipcMain.handle('auth:is-logged-in',()=>false)
  const results=async()=>{
    const rows=await HistoryRepo.list({limit:20}), files=readdirSync(audioDir).filter(f=>f.endsWith('.wav'))
    writeFileSync('tmp/audio-storage/ui-data.json',JSON.stringify({fixtureClockOffsetDays:2,records:rows.map(r=>({id:r.id,status:r.status,text:r.refinedText,modeMeta:String(r.modeMeta)})),files:files.map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(audioDir,name))).digest('hex')})),recycleJournal:AudioStorageRepo.entries().map(r=>({key:r.key,...JSON.parse(r.payload)})),notes:readFileSync(join(audioDir,'notes.txt'),'utf8')},null,2)+'\n')
  }
  let closing = false
  window.on('close',event=>{event.preventDefault();if(closing)return;closing=true;void results().finally(()=>{window.destroy();app.quit()})})
  app.on('will-quit',()=>{closeDatabase()})
  app.on('window-all-closed',()=>app.quit())
  await window.loadFile(resolve('dist/renderer/index.html'))
}).catch(e=>{console.error(e);app.exit(1)})
