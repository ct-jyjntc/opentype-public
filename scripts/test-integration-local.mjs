// Run the real client/server suite against a disposable local server, never the user's account service.
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const directory=mkdtempSync(join(tmpdir(),'opentype-integration-'))
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r))
let server
try{
 execFileSync(resolve('node_modules/.bin/esbuild'),['scripts/test-integration.ts','--bundle','--platform=node','--format=esm','--outfile=node_modules/.cache/test-integration.mjs','--external:undici','--log-level=warning'],{stdio:'inherit'})
 server=spawn(process.execPath,['--experimental-strip-types','src/index.ts'],{cwd:resolve('server'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:join(directory,'test.db'),JWT_SECRET:'isolated-integration-test-key',NODE_ENV:'development',MAIL_API_URL:'',MAIL_API_KEY:'',MAIL_FROM:''},stdio:['ignore','pipe','pipe']})
 let ready=false
 for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)});ready=true;break}catch{if(server.exitCode!==null)throw new Error('test server exited');await new Promise(r=>setTimeout(r,100))}}
 if(!ready)throw new Error('test server did not start')
 const test=spawn(process.execPath,['node_modules/.cache/test-integration.mjs'],{env:{...process.env,CLOUD_URL:`http://127.0.0.1:${port}`},stdio:'inherit'})
 process.exitCode=await new Promise(r=>test.on('exit',code=>r(code??1)))
}finally{if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r))}rmSync(directory,{recursive:true,force:true})}
