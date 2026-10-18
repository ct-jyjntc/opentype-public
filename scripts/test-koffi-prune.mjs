import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Arch } = require('builder-util')
const prune = require('./prune-koffi-payload.cjs')
const root = mkdtempSync(join(tmpdir(), 'opentype-koffi-prune-'))
try {
  const appOutDir = join(root, 'mac-arm64')
  const koffiRoot = join(appOutDir, 'OpenType.app', 'Contents', 'Resources',
    'app.asar.unpacked', 'node_modules', 'koffi', 'build', 'koffi')
  mkdirSync(join(koffiRoot, 'darwin_arm64'), { recursive: true })
  mkdirSync(join(koffiRoot, 'darwin_x64'), { recursive: true })
  mkdirSync(join(koffiRoot, 'linux_x64'), { recursive: true })
  writeFileSync(join(koffiRoot, 'darwin_arm64', 'koffi.node'), 'arm64')
  writeFileSync(join(koffiRoot, 'darwin_x64', 'koffi.node'), 'x64')
  writeFileSync(join(koffiRoot, 'linux_x64', 'koffi.node'), 'linux')
  await prune({
    appOutDir,
    electronPlatformName: 'darwin',
    arch: Arch.arm64,
    packager: { appInfo: { productFilename: 'OpenType' } },
  })
  assert.equal(existsSync(join(koffiRoot, 'darwin_arm64', 'koffi.node')), true)
  assert.equal(existsSync(join(koffiRoot, 'darwin_x64')), false)
  assert.equal(existsSync(join(koffiRoot, 'linux_x64')), false)

  await assert.rejects(prune({
    appOutDir: join(root, 'missing'),
    electronPlatformName: 'darwin',
    arch: Arch.arm64,
    packager: { appInfo: { productFilename: 'OpenType' } },
  }), /Koffi payload directory is missing/)

  const windowsRoot = join(root, 'win-arm64', 'resources', 'app.asar.unpacked',
    'node_modules', 'koffi', 'build', 'koffi')
  mkdirSync(join(windowsRoot, 'win32_arm64'), { recursive: true })
  mkdirSync(join(windowsRoot, 'win32_x64'), { recursive: true })
  writeFileSync(join(windowsRoot, 'win32_arm64', 'koffi.node'), 'arm64')
  writeFileSync(join(windowsRoot, 'win32_x64', 'koffi.node'), 'x64')
  await prune({
    appOutDir: join(root, 'win-arm64'),
    electronPlatformName: 'win32',
    arch: Arch.arm64,
    packager: { appInfo: { productFilename: 'OpenType' } },
  })
  assert.equal(existsSync(join(windowsRoot, 'win32_arm64', 'koffi.node')), true)
  assert.equal(existsSync(join(windowsRoot, 'win32_x64')), false)
  console.log('OK Koffi payload retains only the target platform binding')
} finally {
  rmSync(root, { recursive: true, force: true })
}
