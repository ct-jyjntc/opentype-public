import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
if (version !== '0.2.3') throw new Error(`Expected stable version 0.2.3; got ${version}`)
const base = join(root, 'release', 'staging', version)

async function fileHashes(path) {
  const sha512 = createHash('sha512'), sha256 = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    sha512.update(chunk)
    sha256.update(chunk)
  }
  return { size, sha512: sha512.digest('base64'), sha256: sha256.digest('hex') }
}

async function readFeed(platform, arch) {
  const directory = join(base, `${platform}-${arch}`)
  const feedName = platform === 'macos' ? 'latest-mac.yml' : 'latest.yml'
  const feedPath = join(directory, feedName)
  const feed = yaml.load(await readFile(feedPath, 'utf8'))
  if (String(feed.version) !== version || !Array.isArray(feed.files) || !feed.files.length) {
    throw new Error(`${feedPath} has the wrong version or no files list`)
  }
  const matched = []
  for (const item of feed.files) {
    const name = String(item.url ?? item.path ?? '')
    if (!name || name.includes('/') || name.includes('\\')) throw new Error(`Unsafe release asset path in ${feedPath}: ${name}`)
    const expected = `OpenType-${version}-${platform === 'macos' ? 'macOS' : 'Windows'}-${arch}.`
    if (!name.startsWith(expected)) throw new Error(`${feedPath} points to an asset for a different platform or architecture: ${name}`)
    const path = join(directory, name)
    const actual = await fileHashes(path)
    if (Number(item.size) !== actual.size || item.sha512 !== actual.sha512) {
      throw new Error(`${feedPath} size or SHA-512 mismatch for ${name}`)
    }
    matched.push(item)
  }
  if (!matched.some(item => /\.(dmg|exe|zip)$/.test(item.url ?? item.path ?? ''))) {
    throw new Error(`${feedPath} has no installer/archive entry`)
  }
  return { feed, files: matched }
}

const channels = [
  { platform: 'windows', name: 'latest.yml', arches: ['x64', 'arm64'] },
  // arm64 first: builds before 0.2.2 verify the first ZIP in latest-mac.yml, and every Mac build before 0.2.2 is arm64.
  { platform: 'macos', name: 'latest-mac.yml', arches: ['arm64', 'x64'] },
]

for (const channel of channels) {
  const parts = await Promise.all(channel.arches.map(arch => readFeed(channel.platform, arch)))
  const merged = { ...parts[0].feed, files: parts.flatMap(part => part.files) }
  if (channel.platform === 'macos' && !String(merged.files.find(item => /\.zip$/.test(item.url ?? ''))?.url).endsWith('-macOS-arm64.zip')) {
    throw new Error(`${channel.name} must list the arm64 ZIP first for installed builds before 0.2.2`)
  }
  if (new Set(merged.files.map(item => item.url ?? item.path)).size !== merged.files.length) {
    throw new Error(`${channel.name} contains duplicate asset names`)
  }
  const output = join(base, channel.name)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, yaml.dump(merged, { lineWidth: -1, noRefs: true }), 'utf8')
  console.log(`Merged ${merged.files.length} verified assets into ${output}`)
}

const releaseFiles = []
for (const platform of ['windows', 'macos']) for (const arch of ['x64', 'arm64']) {
  const directory = join(base, `${platform}-${arch}`)
  for (const name of await readdir(directory)) {
    if (/^OpenType-0\.2\.3-(Windows|macOS)-(x64|arm64)\.(exe|dmg|zip)(\.blockmap)?$/.test(name)) {
      releaseFiles.push(join(directory, name))
    }
  }
}
releaseFiles.push(join(base, 'latest.yml'), join(base, 'latest-mac.yml'))
const manifest = []
for (const path of releaseFiles.sort()) {
  const hash = await fileHashes(path)
  manifest.push(`${hash.sha256}  ${path.split(/[\\/]/).at(-1)}`)
}
await writeFile(join(base, `SHA256SUMS-${version}.txt`), `${manifest.join('\n')}\n`, 'utf8')
