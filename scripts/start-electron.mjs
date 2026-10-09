import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], { env: environment, stdio: 'inherit', shell: false })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('close', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
