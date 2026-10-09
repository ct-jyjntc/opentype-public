import { build, transform } from 'esbuild'
import { access, readFile, writeFile } from 'node:fs/promises'

// A narrow, reproducible replacement of the old voice transport. Do not reformat the
// remaining legacy UI: the source migration is incremental and its existing patches matter.
const target = new URL('../frontend/renderer/static/js/UfR9-a2Z.js', import.meta.url)
try {
  await access(target)
} catch {
  throw new Error('Legacy frontend reference files are private and are not included in this public snapshot. Use npm run build for the current editable frontend; see HANDOFF.md for historical compatibility probes.')
}
const importLine = 'import { IpcVoiceTransport as OpenTypeIpcVoiceTransport } from "./opentype-voice-transport.js";\n'
let source = await readFile(target, 'utf8')
const start = source.indexOf('class mf{'), end = source.indexOf('const yf=', start)
const replacement = 'class mf extends OpenTypeIpcVoiceTransport{constructor(handlers,auth){super(handlers,{invoke:(channel,payload)=>window.ipcRenderer.invoke(channel,payload),eventManager:new td({instanceId:_0x3c0453()})});}}'
if (!source.includes(replacement)) {
  if (start < 0 || end < start || !source.slice(start, end).includes("['sendFallbackEvent']")) {
    throw new Error('Voice transport anchor changed; inspect the legacy bundle before rebuilding')
  }
  source = source.slice(0, start) + replacement + source.slice(end)
}
if (!source.startsWith(importLine)) source = importLine + source
await transform(source, { loader: 'js', format: 'esm' }) // Validate before touching the shipped bundle.
await build({ entryPoints: ['src/renderer/compat/ipc-voice-transport.ts'], bundle: true,
  format: 'esm', platform: 'browser', target: 'chrome130',
  outfile: 'frontend/renderer/static/js/opentype-voice-transport.js' })
await writeFile(target, source)

const configTarget = new URL('../frontend/renderer/static/js/DLh7vjiS.js', import.meta.url)
let configSource = await readFile(configTarget, 'utf8')
const oldConfig = "const On='http://192.0.2.1:9100',In='http://192.0.2.1:9100',Pn='0.1.0'"
const runtimeConfig = 'const On=window.opentypeRuntime.cloudBaseUrl,In=window.opentypeRuntime.cloudBaseUrl,Pn=window.opentypeRuntime.appVersion'
if (!configSource.includes(runtimeConfig)) {
  if (!configSource.includes(oldConfig)) throw new Error('Renderer config anchor changed')
  configSource = configSource.replace(oldConfig, runtimeConfig)
}
await transform(configSource, { loader: 'js', format: 'esm' })
await build({ entryPoints: ['src/preload/compat-runtime.ts'], bundle: true,
  format: 'cjs', platform: 'node', target: 'node20', external: ['electron'],
  outfile: 'frontend/preload/runtime.cjs' })
const preloadTarget = new URL('../frontend/preload/index.cjs', import.meta.url)
let preload = await readFile(preloadTarget, 'utf8')
const runtimeRequire = 'require("./runtime.cjs");\n'
if (!preload.startsWith(runtimeRequire)) preload = runtimeRequire + preload
await writeFile(preloadTarget, preload)
await writeFile(configTarget, configSource)
console.log('Built the shipped renderer IPC voice transport')
