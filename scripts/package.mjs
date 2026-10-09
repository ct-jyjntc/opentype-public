import { spawnSync } from 'node:child_process'
const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run pack 使用此入口。')
function run(args) {
  const child = spawnSync(process.execPath, [npm, ...args], { stdio: 'inherit', shell: false })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
run(['run', 'build'])
run(['exec', '--', 'electron-builder', ...(process.platform === 'win32' ? ['--config', 'electron-builder.windows.cjs', '--win', 'nsis', '--x64'] : [])])
