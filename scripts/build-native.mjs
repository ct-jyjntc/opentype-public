import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
if (process.platform === 'darwin') run('/bin/bash', [join(root, 'scripts/build-native.sh')])
else if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('Windows 当前使用 x64 Electron/Node 与 SenseVoice 运行库；请在 x64 开发环境构建。')
  const source = join(root, 'native/windows'), build = join(source, 'build/cmake')
  run('cmake', ['-S', source, '-B', build, '-A', 'x64'])
  run('cmake', ['--build', build, '--config', 'Release'])
} else throw new Error('此平台的原生组件尚未实现；当前构建入口支持 macOS 和 Windows x64。')
