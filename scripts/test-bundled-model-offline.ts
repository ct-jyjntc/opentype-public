import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import { SenseVoiceModelStore, SENSEVOICE_FILES } from '../src/main/services/local-asr/model-store'
const source = process.argv[2]
assert(source, 'packaged model directory required')
// The parent runs this in a macOS sandbox which forbids outbound networking.
const server = createServer(socket => { socket.destroy(); server.close(); throw new Error('network isolation failed') })
await new Promise<void>(resolve => server.listen(0,'127.0.0.1', resolve))
try {
  const address = server.address() as { port: number }
  await new Promise<void>((resolve,reject) => {
    const socket = connect(address.port,'127.0.0.1')
    socket.on('error',error => { if ((error as NodeJS.ErrnoException).code === 'EPERM') resolve(); else reject(error) })
    socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('network test timed out'))})
  })
} finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
const directory = await mkdtemp(join(tmpdir(),'opentype-offline-bundle-'))
try {
  const model = new SenseVoiceModelStore(directory)
  assert.equal((await model.importBundle(source)).state,'ready')
  const before = await stat(join(directory,SENSEVOICE_FILES[0].name),{bigint:true})
  await unlink(join(directory,'tokens.txt'))
  assert.equal((await model.check()).state,'missing')
  assert.equal((await model.install(source)).state,'ready')
  for (const file of SENSEVOICE_FILES) assert.deepEqual(await readFile(join(directory,file.name)),await readFile(join(source,file.name)))
  assert.equal((await stat(join(directory,SENSEVOICE_FILES[0].name),{bigint:true})).ino,before.ino)
  console.log('PASS operating system denies outbound connections; real packaged model installs and repairs without network; valid existing model retained')
} finally { await rm(directory,{recursive:true,force:true}) }
