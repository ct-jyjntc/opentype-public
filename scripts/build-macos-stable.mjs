import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const arch = process.argv[2]
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (process.platform !== 'darwin') throw new Error('macOS stable packages must be built on macOS.')
if (version !== '0.2.3') throw new Error(`expected stable package version 0.2.3, got ${version}`)
if (!['x64', 'arm64'].includes(arch)) throw new Error('usage: node scripts/build-macos-stable.mjs <x64|arm64>')
const output = join(root, 'release', 'staging', version, `macos-${arch}`)
const feedName = 'latest-mac.yml'
const provenanceName = 'BUILD-PROVENANCE.json'
const sumName = `SHA256SUMS-macOS-${arch}.txt`

const env = {
  ...process.env,
  OPEN_TYPE_NATIVE_ARCH: arch,
  OPENTYPE_MACOS_ARCH: arch,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function check(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'ignore', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed`)
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function packageVersion(name) {
  return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function findApps(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (entry.name.endsWith('.app')) found.push(path)
    else await findApps(path, found)
  }
  return found
}

function requireArch(path, expected) {
  const actual = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim()
  if (actual !== expected) throw new Error(`wrong architecture in ${relative(root, path)}: expected ${expected}, got ${actual}`)
}

async function packagedModel(resources) {
  const source = await readFile(join(root, 'src', 'main', 'services', 'local-asr', 'model-store.ts'), 'utf8')
  const revision = source.match(/SENSEVOICE_REVISION\s*=\s*'([^']+)'/)?.[1]
  const block = source.match(/SENSEVOICE_FILES\s*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
  const expected = [...block.matchAll(/\{ name: '([^']+)', bytes: (\d+), sha256: '([0-9a-f]{64})' \}/g)]
    .map(([, name, bytes, hash]) => ({ name, bytes: Number(bytes), sha256: hash }))
  if (!revision || expected.length === 0) throw new Error('could not parse packaged model manifest')
  const files = []
  for (const file of expected) {
    const path = join(resources, 'models', 'sensevoice-int8', file.name)
    const info = await stat(path)
    const hash = await sha256(path)
    if (info.size !== file.bytes || hash !== file.sha256) throw new Error(`packaged model mismatch: ${file.name}`)
    files.push({ name: file.name, bytes: info.size, sha256: hash })
  }
  return { revision, files }
}

const sourceStatus = git(['status', '--porcelain=v1', '--untracked-files=no'])
if (sourceStatus) throw new Error(`stable packages require a clean tracked working tree:\n${sourceStatus}`)
const sourceHead = git(['rev-parse', 'HEAD'])
let sourceBranch = 'detached'
try { sourceBranch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']) } catch {}
const diffHash = createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })).digest('hex')

// A failed rebuild must never leave the previous package's evidence next to new or partial assets.
await Promise.all([provenanceName, sumName, feedName].map(name => rm(join(output, name), { force: true })))

// Keep the host's tooling architecture active while the source build runs, then
// select the package CPU before electron-builder collects node_modules. npm
// filters platform-specific optional packages by CPU, including the ASR addon.
run('npm', [
  'ci', '--os=darwin', `--cpu=${process.arch}`,
  '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'
])
run('npm', ['run', 'build'])
run('npm', [
  'ci', '--os=darwin', `--cpu=${arch}`,
  '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'
])
run('node_modules/.bin/electron-builder', [
  '--config', 'electron-builder.macos.stable.cjs',
  '--mac', 'dmg', 'zip', `--${arch}`,
  '--publish', 'never'
])

const names = await readdir(output)
const apps = await findApps(output)
if (apps.length !== 1) throw new Error(`expected exactly one packaged OpenType.app, found ${apps.length}`)
const app = apps[0]
const resources = join(app, 'Contents', 'Resources')
const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
const nativePaths = [
  join(app, 'Contents', 'MacOS', 'OpenType'),
  join(unpacked, `sherpa-onnx-darwin-${arch}`, 'sherpa-onnx.node'),
  join(unpacked, `sherpa-onnx-darwin-${arch}`, 'libonnxruntime.dylib'),
  join(unpacked, `sherpa-onnx-darwin-${arch}`, 'libsherpa-onnx-c-api.dylib'),
  join(unpacked, `sherpa-onnx-darwin-${arch}`, 'libsherpa-onnx-cxx-api.dylib'),
  join(unpacked, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  join(unpacked, 'koffi', 'build', 'koffi', arch === 'x64' ? 'darwin_x64' : 'darwin_arm64', 'koffi.node'),
  join(resources, 'lib', 'input-helper', 'build', 'libInputHelper.dylib'),
  join(resources, 'lib', 'keyboard-helper', 'build', 'libKeyboardHelper.dylib'),
  join(resources, 'lib', 'context-helper', 'build', 'libContextHelper.dylib'),
  join(resources, 'lib', 'util-helper', 'build', 'libUtilHelper.dylib'),
  join(resources, 'lib', 'output-audio', 'build', 'OutputAudio'),
  join(resources, 'lib', 'apple-speech', 'build', 'AppleSpeech')
]
const unexpectedSherpaArch = arch === 'x64' ? 'arm64' : 'x64'
if (existsSync(join(unpacked, `sherpa-onnx-darwin-${unexpectedSherpaArch}`))) {
  throw new Error(`packaged app contains sherpa-onnx-darwin-${unexpectedSherpaArch}`)
}
const koffiPlatforms = await readdir(join(unpacked, 'koffi', 'build', 'koffi'))
const expectedKoffiPlatform = arch === 'x64' ? 'darwin_x64' : 'darwin_arm64'
if (koffiPlatforms.length !== 1 || koffiPlatforms[0] !== expectedKoffiPlatform) {
  throw new Error(`unexpected Koffi platform payload: ${koffiPlatforms.join(', ')}`)
}
for (const path of nativePaths) requireArch(path, arch === 'x64' ? 'x86_64' : 'arm64')
run('codesign', ['--verify', '--deep', '--strict', app])
if (!names.includes(feedName)) throw new Error(`electron-builder did not produce ${feedName}`)
const feed = await readFile(join(output, feedName), 'utf8')
if (!new RegExp(`^version: ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(feed)) {
  throw new Error(`${feedName} version does not match ${version}`)
}
const assets = names.filter(name => new RegExp(`^OpenType-${version}-macOS-${arch}\\.(dmg|zip)(\\.blockmap)?$`).test(name)).sort()
const installers = assets.filter(name => /\.(dmg|zip)$/.test(name))
if (!installers.some(name => name.endsWith('.dmg')) || !installers.some(name => name.endsWith('.zip'))) {
  throw new Error('electron-builder did not produce both macOS DMG and ZIP assets')
}
const feedEntries = [...feed.matchAll(/^\s+- url: ([^\r\n]+)\r?\n\s+sha512: ([A-Za-z0-9+/=]+)\r?\n\s+size: (\d+)/gm)]
if (feedEntries.length !== installers.length) throw new Error(`${feedName} must contain exactly one entry per installer`)
for (const installer of installers) {
  const entry = feedEntries.find(([, url]) => url === installer)
  if (!entry) throw new Error(`${feedName} has no update entry for ${installer}`)
  const installerPath = join(output, installer)
  const installerInfo = await stat(installerPath)
  const installerHash = createHash('sha512')
  for await (const chunk of createReadStream(installerPath)) installerHash.update(chunk)
  if (Number(entry[3]) !== installerInfo.size || entry[2] !== installerHash.digest('base64')) {
    throw new Error(`${feedName} size or sha512 does not match ${installer}`)
  }
}
const dmg = installers.find(name => name.endsWith('.dmg'))
const zip = installers.find(name => name.endsWith('.zip'))
check('hdiutil', ['verify', join(output, dmg)], 'DMG checksum verification')
check('unzip', ['-t', join(output, zip)], 'ZIP integrity verification')

const finalStatus = git(['status', '--porcelain=v1', '--untracked-files=no'])
if (finalStatus || git(['rev-parse', 'HEAD']) !== sourceHead) {
  throw new Error(`working tree or HEAD changed during build:\n${finalStatus}`)
}

const artifacts = await Promise.all(installers.map(async name => {
  const path = join(output, name)
  return { name, bytes: (await stat(path)).size, sha256: await sha256(path) }
}))
const provenance = {
  type: `stable macOS ${arch} build from pushed source; ad-hoc signed; not notarized`,
  builtAt: new Date().toISOString(),
  version,
  arch,
  source: {
    head: sourceHead,
    branch: sourceBranch,
    dirty: false,
    dirtyFiles: [],
    workingTreeDiffSha256: diffHash
  },
  environment: {
    hostArch: process.arch,
    node: process.version,
    npm: execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
    electron: packageVersion('electron'),
    electronBuilder: packageVersion('electron-builder'),
    drizzleOrm: packageVersion('drizzle-orm'),
    macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  },
  model: await packagedModel(resources),
  artifacts,
  verification: {
    sourceClean: 'passed: tracked working tree and HEAD stayed unchanged throughout the build',
    packagedArchitectureCheck: `passed: app and bundled native dependencies are ${arch}`,
    koffiPayload: `passed: only ${expectedKoffiPlatform} retained`,
    updateFeed: 'passed: version, sizes and SHA-512 entries match the installers',
    codesignDeepStrict: 'passed',
    dmgChecksum: 'passed',
    zipIntegrity: 'passed',
    packagedModelHashes: 'passed',
    sha256Manifest: `generated: includes installers, blockmaps, ${feedName} and ${provenanceName}`
  },
  signing: {
    identity: 'adhoc',
    hardenedRuntime: true,
    notarized: false,
    gatekeeperAssessmentMeaningful: false,
    note: 'Gatekeeper assessment on this host is disabled and is not evidence of notarization.'
  }
}
const provenancePath = join(output, provenanceName)
const provenanceTemporary = `${provenancePath}.${process.pid}.tmp`
await writeFile(provenanceTemporary, `${JSON.stringify(provenance, null, 2)}\n`)
await rename(provenanceTemporary, provenancePath)

const sums = await Promise.all([...assets, feedName, provenanceName]
  .map(async name => `${await sha256(join(output, name))}  ${name}`))
await writeFile(join(output, sumName), `${sums.join('\n')}\n`)
