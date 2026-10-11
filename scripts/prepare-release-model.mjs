import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'

const source = await readFile('src/main/services/local-asr/model-store.ts', 'utf8')
const revision = source.match(/export const SENSEVOICE_REVISION = '([a-f0-9]{40})'/)?.[1]
const files = [...source.matchAll(/\{ name: '([^']+)', bytes: (\d+), sha256: '([a-f0-9]{64})' \}/g)]
  .map(([, name, bytes, sha256]) => ({ name, bytes: Number(bytes), sha256 }))

if (!revision || files.length !== 2 || new Set(files.map(file => file.name)).size !== files.length ||
    !['model.int8.onnx', 'tokens.txt'].every(name => files.some(file => file.name === name))) {
  throw new Error('Could not read the pinned SenseVoice model manifest from model-store.ts')
}

const directory = process.env.SENSEVOICE_MODEL_DIR
  ? process.env.SENSEVOICE_MODEL_DIR
  : join('gateway', 'models', 'sensevoice-int8')
await mkdir(directory, { recursive: true })

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

for (const file of files) {
  if (!/^[a-z0-9.-]+$/.test(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
    throw new Error(`Invalid SenseVoice manifest entry: ${file.name}`)
  }
  const destination = join(directory, file.name)
  try {
    const existing = await lstat(destination)
    if (existing.isFile() && existing.size === file.bytes && await sha256(destination) === file.sha256) {
      console.log(`Reusing verified ${file.name}: ${file.bytes} bytes sha256 ${file.sha256}`)
      continue
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const url = `https://www.opentype.top/downloads/models/sensevoice-int8/${revision}/${file.name}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) })
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') {
    throw new Error(`SenseVoice download failed for ${file.name}: HTTP ${response.status}`)
  }

  const temporary = join(directory, `${file.name}.release-part`)
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > file.bytes) return callback(new Error(`SenseVoice size mismatch for ${file.name}`))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'w' }))
    const digest = hash.digest('hex')
    if (bytes !== file.bytes || digest !== file.sha256 || (await stat(temporary)).size !== file.bytes) {
      throw new Error(`SenseVoice integrity check failed for ${file.name}`)
    }
    await rm(destination, { force: true })
    await rename(temporary, destination)
    console.log(`Verified ${file.name}: ${bytes} bytes sha256 ${digest}`)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
