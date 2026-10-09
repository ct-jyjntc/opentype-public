// Real service + Electron SQLite client, with disposable databases and accounts only.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'opentype-cloud-delete-'))
const reservation = createServer()
await new Promise(r => reservation.listen(0, '127.0.0.1', r))
const port = reservation.address().port
await new Promise(r => reservation.close(r))
let server
try {
  const suite = process.argv.includes('--lifecycle') ? 'cloud-lifecycle' : 'cloud-deletion'
  const bundle = `node_modules/.cache/test-${suite}.mjs`
  execFileSync(resolve('node_modules/.bin/esbuild'), [`scripts/test-${suite}-electron.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--external:better-sqlite3', '--external:drizzle-orm', '--external:undici', '--log-level=warning'], { stdio: 'inherit' })
  server = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: resolve('server'), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: join(directory, 'server.db'), JWT_SECRET: 'isolated-cloud-delete-test', NODE_ENV: 'development', MAIL_API_URL: '', MAIL_API_KEY: '', MAIL_FROM: '' },
    stdio: 'ignore',
  })
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); ready = true; break }
    catch { if (server.exitCode !== null) throw new Error('test server exited'); await new Promise(r => setTimeout(r, 100)) }
  }
  if (!ready) throw new Error('test server did not start')
  const test = spawn(resolve('node_modules/.bin/electron'), [bundle], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLOUD_DELETE_TEST_URL: `http://127.0.0.1:${port}`, CLOUD_DELETE_TEST_DIR: directory }, stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => { test.on('exit', code => resolve(code ?? 1)); test.on('error', reject) })
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)) }
  rmSync(directory, { recursive: true, force: true })
}
