import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const directory = fileURLToPath(new URL(`../release/testing/${version}/`, import.meta.url))
const names = await readdir(directory)
if (!names.includes('beta-mac.yml')) throw new Error('electron-builder did not produce beta-mac.yml')
if (names.includes('latest-mac.yml')) throw new Error('Refusing beta output containing latest-mac.yml')
const updateInfo = await readFile(join(directory, 'beta-mac.yml'), 'utf8')
if (!new RegExp(`^version: ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(updateInfo)) {
  throw new Error('beta-mac.yml version does not match package.json')
}

const assets = names.filter(name => name === 'beta-mac.yml' || /^OpenType-.*-macOS-arm64\.(dmg|zip)(\.blockmap)?$/.test(name)).sort()
const installers = assets.filter(name => /\.dmg$|\.zip$/.test(name))
if (!installers.some(name => name.endsWith('.dmg')) || !installers.some(name => name.endsWith('.zip'))) {
  throw new Error('electron-builder did not produce both macOS DMG and ZIP assets')
}

const updateEntries = [...updateInfo.matchAll(/^\s+- url: ([^\r\n]+)\r?\n\s+sha512: ([A-Za-z0-9+/=]+)\r?\n\s+size: (\d+)/gm)]
for (const name of installers) {
  const entry = updateEntries.find(([, url]) => url === name)
  if (!entry) throw new Error(`beta-mac.yml has no update entry for ${name}`)
  const data = await readFile(join(directory, name))
  const info = await stat(join(directory, name))
  const sha512 = createHash('sha512').update(data).digest('base64')
  if (Number(entry[3]) !== info.size || entry[2] !== sha512) {
    throw new Error(`beta-mac.yml size or sha512 does not match ${name}`)
  }
}

const lines = await Promise.all(assets.map(async name => {
  const data = await readFile(join(directory, name))
  return `${createHash('sha256').update(data).digest('hex')}  ${name}`
}))
await writeFile(join(directory, 'SHA256SUMS-macOS-arm64.txt'), `${lines.join('\n')}\n`)
