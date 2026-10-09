// Stages deliberately leave the app open for native UI verification with CUA.
// No debug port, preload injection, or modification of the delivered application is used.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const root = resolve('tmp/startup'), statePath = join(root, 'packaged-test.json')
mkdirSync(root, { recursive: true })
const { version } = JSON.parse(readFileSync('package.json','utf8'))
const release = resolve('release/testing',version)
const stage = process.argv[2]
if (stage === 'prepare') {
  assert(!existsSync(statePath), 'existing test state must not be overwritten')
  const directory = mkdtempSync(join(tmpdir(), 'opentype-packaged-startup-'))
  const mount = join(directory,'mounted'), installed = join(directory,'installed'), profile = join(directory,'profile')
  for (const path of [mount,installed,profile]) mkdirSync(path)
  execFileSync('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,join(release,`OpenType-${version}-macOS-arm64.dmg`)],{stdio:'ignore'})
  try { execFileSync('ditto',[join(mount,'OpenType.app'),join(installed,'OpenType.app')]) }
  finally { execFileSync('hdiutil',['detach',mount],{stdio:'ignore'}) }
  const app = join(installed,'OpenType.app')
  execFileSync('codesign',['--verify','--deep','--strict',app])
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  assert.equal(hash(join(app,'Contents/Resources/app.asar')), hash(join(release,'mac-arm64/OpenType.app/Contents/Resources/app.asar')))
  writeFileSync(statePath, JSON.stringify({ version, directory, app, profile, copiedFromDmg:true, signatureVerified:true },null,2)+'\n')
  console.log('Prepared signed DMG copy and empty independent profile')
} else if (stage === 'launch' || stage === 'second') {
  const state = JSON.parse(readFileSync(statePath,'utf8'))
  assert.equal(state.version,version)
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.OPENTYPE_TEST_USER_DATA_DIR
  const child = spawn(join(state.app,'Contents/MacOS/OpenType'),[`--user-data-dir=${state.profile}`],{env,stdio:'inherit'})
  console.log(JSON.stringify({stage,pid:child.pid,packaged:true,independentProfile:true,electronSandboxEnabled:true}))
  process.exitCode = await new Promise(resolveExit=>child.on('exit',code=>resolveExit(code??1)))
} else { throw new Error('Expected prepare, launch or second') }
