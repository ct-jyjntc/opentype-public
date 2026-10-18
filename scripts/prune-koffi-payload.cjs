const { lstatSync, readdirSync, rmSync } = require('node:fs')
const { isAbsolute, join, relative, resolve } = require('node:path')
const { Arch } = require('builder-util')

/**
 * Koffi ships one native binding per platform. Electron Builder otherwise
 * unpacks all of them into every installer, so keep only the target directory.
 */
module.exports = async function pruneKoffiPayload(context) {
  const platform = context.electronPlatformName
  if (!['darwin', 'win32', 'linux'].includes(platform)) return
  const platformKey = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
  const arch = Arch[context.arch]
  if (!arch || arch === 'universal') return

  const productName = context.packager?.appInfo?.productFilename ?? 'OpenType'
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const koffiRoot = join(resources, 'app.asar.unpacked', 'node_modules', 'koffi', 'build', 'koffi')
  let entries
  try {
    entries = readdirSync(koffiRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  const keep = `${platformKey}_${arch}`
  const root = resolve(koffiRoot)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === keep) continue
    const target = resolve(root, entry.name)
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing to prune outside Koffi root: ${target}`)
    const info = lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    rmSync(target, { recursive: true, force: false })
  }
}
