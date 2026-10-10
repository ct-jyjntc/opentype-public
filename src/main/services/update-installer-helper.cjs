// This helper runs under Electron's executable, where node:fs treats app.asar
// as a virtual filesystem. Bundle replacement and recursive cleanup need raw
// filesystem semantics so app.asar remains an ordinary archive file.
const fs = require('original-fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const guiAppEnv = { ...process.env }
delete guiAppEnv.ELECTRON_RUN_AS_NODE

const configPath = process.argv[2]
let config
const log = message => {
  if (!config?.logPath) return
  try { fs.appendFileSync(config.logPath, `${new Date().toISOString()} ${message}\n`, { mode:0o600 }) } catch {}
}
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)
const exists = file => { try { fs.lstatSync(file); return true } catch { return false } }
let resultWritten = false
const writeResult = result => {
  resultWritten = true
  try { fs.writeFileSync(config.resultPath, JSON.stringify({ ...result, at:new Date().toISOString() }), { mode:0o600 }) } catch {}
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms))
// The relaunched candidate gets the confirmation switches; a rolled-back old
// app must not, otherwise it would treat itself as an install confirmation.
const profileArgs = () => (config.relaunchArgs || []).filter(arg => arg.startsWith('--user-data-dir='))
// Must stay longer than the app's own quit fallback (updater.ts), so the app
// always gives up first; the app then terminates this helper before cleanup.
const OLD_APP_EXIT_TIMEOUT_MS = 90_000
const STARTUP_CONFIRM_TIMEOUT_MS = 120_000
const CANDIDATE_START_TIMEOUT_MS = 30_000
// Until the old app has exited nothing has been moved, so the app may still cancel.
let committed = false
const processList = () => {
  const result = spawnSync('/bin/ps', ['-axo','pid=,command='], { encoding:'utf8' })
  if (result.error || result.status !== 0) throw new Error(`无法确认更新进程状态：${result.error?.message || result.status}`)
  return result.stdout || ''
}
const findCandidatePid = executable => {
  for (const line of processList().split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match || !(match[2] === executable || match[2].startsWith(`${executable} `)) || !match[2].includes(`--update-install-confirm-token=${config.confirmToken}`)) continue
    if ((config.relaunchArgs || []).some(arg => !match[2].includes(arg))) continue
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid !== process.pid) return pid
  }
}

async function run() {
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('安装配置路径无效')
  const configStat = fs.lstatSync(configPath)
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 64 * 1024) throw new Error('安装配置文件无效')
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  for (const key of ['appPath','stageRoot','stagedApp','parentPath','resultPath','logPath','userDataPath']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error('安装配置路径无效')
  }
  if (!Number.isSafeInteger(config.pid) || config.pid < 1 || typeof config.version !== 'string' || typeof config.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(config.sha512)) throw new Error('安装配置内容无效')
  if (!['adhoc','unsigned'].includes(config.currentIdentity) || !/^[a-f0-9]{32}$/.test(config.confirmToken) || typeof config.startupConfirmation !== 'boolean') throw new Error('启动确认参数无效')
  if (config.startupConfirmation && (typeof config.markerPath !== 'string' || !path.isAbsolute(config.markerPath))) throw new Error('启动确认参数无效')
  if (!Array.isArray(config.relaunchArgs) || config.relaunchArgs.some(value => typeof value !== 'string' || !/^--(?:user-data-dir=|update-install-confirm-path=|update-install-confirm-token=)/.test(value) || value.includes('\0'))) throw new Error('重启参数无效')
  for (const candidate of [config.appPath,config.stageRoot,config.stagedApp]) {
    const info = fs.lstatSync(candidate)
    if (info.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) throw new Error('安装路径不能是符号链接或已改变')
  }
  const target = config.appPath, staged = config.stagedApp, stageRoot = config.stageRoot
  const parent = fs.realpathSync(config.parentPath)
  if (path.dirname(target) !== parent || path.dirname(staged) !== stageRoot || path.dirname(stageRoot) !== parent) throw new Error('安装路径已改变')
  if (path.basename(target) !== 'OpenType.app' || !target.endsWith('.app') || !inside(parent,staged) || !inside(parent,target)) throw new Error('安装路径无效')
  const bundleId = spawnSync('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleIdentifier',path.join(staged,'Contents','Info.plist')], { encoding:'utf8' })
  if (bundleId.error || bundleId.status !== 0 || bundleId.stdout.trim() !== 'dev.opentype.desktop') throw new Error('暂存应用身份验证失败')
  const signature = spawnSync('/usr/bin/codesign', ['--verify','--deep','--strict',staged], { encoding:'utf8' })
  if (signature.error || signature.status !== 0) throw new Error(`暂存应用签名完整性检查失败：${signature.stderr || signature.error?.message || signature.status}`)
  const details = spawnSync('/usr/bin/codesign', ['-dv','--verbose=4',staged], { encoding:'utf8' })
  if (details.error || details.status !== 0 || !/^Signature=adhoc\s*$/m.test(`${details.stdout}\n${details.stderr}`)) throw new Error('暂存应用不是有效的 ad-hoc 签名版本')
  if (config.startupConfirmation && (path.dirname(config.markerPath) !== path.dirname(config.resultPath) || path.basename(config.markerPath) !== `confirm-${config.confirmToken}.json` || exists(config.markerPath))) throw new Error('启动确认文件路径无效')
  process.stdout.write('READY\n')

  const waitMs = Math.min(Math.max(Number(config.timeoutMs) || OLD_APP_EXIT_TIMEOUT_MS,OLD_APP_EXIT_TIMEOUT_MS),180_000), deadline = Date.now() + waitMs
  let oldAppExited = false
  while (!oldAppExited && Date.now() < deadline) {
    try { process.kill(config.pid,0); await sleep(250) }
    catch (error) { if (error.code === 'ESRCH') oldAppExited = true; else throw error }
  }
  if (!oldAppExited) {
    try { process.kill(config.pid,0) }
    catch (error) { if (error.code === 'ESRCH') oldAppExited = true; else throw error }
  }
  if (!oldAppExited) {
    // Nothing has been moved yet and the old app is still running, so relaunch nothing.
    log(`old app pid=${config.pid} did not exit within ${waitMs / 1000}s; install cancelled, nothing changed`)
    writeResult({ ok:false,cancelled:true,error:'OpenType 未能在限定时间内退出，安装已取消' })
    throw new Error('OpenType 尚未退出，已取消安装')
  }

  committed = true
  const backup = path.join(parent,`.opentype-backup-${process.pid}-${Date.now()}.app`)
  let movedOld = false, movedNew = false, launchedCandidatePid
  try {
    if (!fs.lstatSync(target).isDirectory() || !fs.lstatSync(staged).isDirectory()) throw new Error('应用目录无效')
    fs.renameSync(target,backup); movedOld = true
    fs.renameSync(staged,target); movedNew = true
    const executableName = spawnSync('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleExecutable',path.join(target,'Contents','Info.plist')], { encoding:'utf8' }).stdout.trim()
    if (!executableName || executableName.includes('/') || executableName.includes('\\')) throw new Error('新版本执行文件无效')
    const executable = path.join(target,'Contents','MacOS',executableName)
    const opened = spawnSync('/usr/bin/open', ['-n','-a',target,'--args',...(config.relaunchArgs || [])], { encoding:'utf8', stdio:'ignore', env:guiAppEnv })
    if (opened.error || opened.status !== 0) throw new Error(`新版本启动失败：${opened.error?.message || opened.status}`)

    if (config.startupConfirmation) {
      const launchedAt = Date.now(), startupDeadline = launchedAt + STARTUP_CONFIRM_TIMEOUT_MS
      let confirmed, seenPid, lastProbe = 0
      // null = ps failed (state unknown), undefined = no candidate process.
      const probeCandidate = () => { try { return findCandidatePid(executable) } catch { return null } }
      while (Date.now() < startupDeadline) {
        try {
          const marker = JSON.parse(fs.readFileSync(config.markerPath,'utf8'))
          const profileMatches = fs.realpathSync(marker.userDataPath) === fs.realpathSync(config.userDataPath)
          if (marker.token === config.confirmToken && Number.isSafeInteger(marker.pid) && marker.pid > 0 && marker.version === config.version && profileMatches) {
            launchedCandidatePid = marker.pid
            process.kill(marker.pid,0)
            if (findCandidatePid(executable) === marker.pid) { confirmed = marker; break }
          }
        } catch {}
        // The new build may sit at a blocking keychain prompt before it can
        // confirm; only an exited (or never started) candidate means failure.
        if (Date.now() - lastProbe >= 1000) {
          lastProbe = Date.now()
          const pid = probeCandidate()
          if (pid) seenPid = launchedCandidatePid = pid
          else if (pid === undefined) {
            if (seenPid) throw new Error('新版本启动后退出，正在恢复旧版本')
            if (Date.now() - launchedAt > CANDIDATE_START_TIMEOUT_MS) throw new Error('新版本进程未启动，正在恢复旧版本')
          }
        }
        await sleep(250)
      }
      if (confirmed) {
        writeResult({ ok:true,version:config.version,pid:confirmed.pid,startupConfirmed:true })
        log(`installed ${config.version}; startup confirmed pid=${confirmed.pid}`)
        try { fs.rmSync(backup,{ recursive:true,force:true }) } catch (error) { log(`old app backup retained at ${backup}: ${error.message}`) }
        try { fs.rmSync(config.markerPath,{ force:true }) } catch {}
      } else {
        const probed = probeCandidate()
        let pid = probed
        if (probed === null && seenPid) try { process.kill(seenPid,0); pid = seenPid } catch { pid = undefined }
        if (!pid) throw new Error('新版本未完成启动确认且已退出，正在恢复旧版本')
        // Alive but unconfirmed (e.g. waiting on a keychain prompt): keep it
        // running and keep the backup, like the legacy no-confirmation path.
        writeResult({ ok:true,version:config.version,pid,startupConfirmed:false,backupPath:backup })
        log(`installed ${config.version}; process alive but unconfirmed after ${STARTUP_CONFIRM_TIMEOUT_MS / 1000}s pid=${pid}; backup retained at ${backup}`)
      }
    } else {
      let pid
      const startupDeadline = Date.now() + 30_000
      while (Date.now() < startupDeadline && !pid) {
        pid = findCandidatePid(executable)
        if (!pid) await sleep(250)
      }
      if (!pid) throw new Error('新版本进程未启动，正在恢复旧版本')
      const stableUntil = Date.now() + 3000
      while (Date.now() < stableUntil) {
        try { process.kill(pid,0) } catch { throw new Error('新版本进程启动后立即退出，正在恢复旧版本') }
        await sleep(250)
      }
      writeResult({ ok:true,version:config.version,pid,startupConfirmed:false,backupPath:backup })
      log(`installed ${config.version}; process alive pid=${pid}; backup retained at ${backup}`)
    }
  } catch (error) {
    if (config.startupConfirmation) try { fs.rmSync(config.markerPath,{ force:true }) } catch {}
    let candidatePid = launchedCandidatePid, lookupFailed = false
    try {
      const executableName = spawnSync('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleExecutable',path.join(target,'Contents','Info.plist')], { encoding:'utf8' }).stdout.trim()
      const executable = path.join(target,'Contents','MacOS',executableName)
      candidatePid = findCandidatePid(executable) || candidatePid
      if (candidatePid) {
        try { process.kill(candidatePid,'SIGTERM') } catch (killError) { if (killError.code !== 'ESRCH') throw killError }
        const exited = async (timeoutMs) => {
          const until = Date.now() + timeoutMs
          while (Date.now() < until) {
            try { process.kill(candidatePid,0) } catch (probeError) { if (probeError.code === 'ESRCH') return true; throw probeError }
            await new Promise(resolve => setTimeout(resolve,200))
          }
          try { process.kill(candidatePid,0); return false } catch (probeError) { return probeError.code === 'ESRCH' }
        }
        let stopped = await exited(5000)
        if (!stopped) {
          try { process.kill(candidatePid,'SIGKILL') } catch (killError) { if (killError.code !== 'ESRCH') log(`candidate SIGKILL failed pid=${candidatePid}: ${killError.message}`) }
          stopped = await exited(5000)
        }
        if (!stopped) {
          log(`rollback deferred: candidate pid=${candidatePid} is still alive; new app and backup retained at ${target} and ${backup}`)
          writeResult({ ok:false,rollbackPending:true,pid:candidatePid,appPath:target,backupPath:backup,error:'更新进程无法停止，已保留新旧应用目录供手动恢复' })
          throw new Error('更新进程无法停止，已保留新旧应用目录供手动恢复')
        }
      }
    } catch (stopError) {
      if (candidatePid || !config.startupConfirmation) {
        log(`rollback deferred because process state is uncertain: ${stopError.message}; target=${target}; backup=${backup}`)
        writeResult({ ok:false,rollbackPending:true,pid:candidatePid,appPath:target,backupPath:backup,error:stopError.message })
        throw stopError
      }
      lookupFailed = true
    }
    if (lookupFailed) {
      log(`rollback deferred because candidate PID could not be checked; target=${target}; backup=${backup}`)
      writeResult({ ok:false,rollbackPending:true,appPath:target,backupPath:backup,error:'无法确认新版本进程状态，已保留新旧应用目录' })
      throw new Error('无法确认新版本进程状态，已保留新旧应用目录')
    }
    try {
      if (movedNew && exists(target)) fs.rmSync(target,{ recursive:true,force:true })
      if (movedOld && exists(backup)) fs.renameSync(backup,target)
    } catch (restoreError) {
      log(`rollback failed: ${restoreError.message}`)
      if (movedOld && exists(backup)) {
        writeResult({ ok:false,rollbackPending:true,appPath:target,backupPath:backup,error:`${error.message}；恢复旧版本失败：${restoreError.message}` })
        throw error
      }
    }
    log(`install failed: ${error.stack || error.message}`)
    writeResult({ ok:false,error:error.message })
    if (exists(target)) spawnSync('/usr/bin/open',['-n','-a',target,'--args',...profileArgs()],{ stdio:'ignore',env:guiAppEnv })
    throw error
  } finally {
    try { fs.rmSync(config.stageRoot,{ recursive:true,force:true }) } catch (error) { log(`stage cleanup failed: ${error.message}`) }
    try { fs.rmSync(configPath,{ force:true }) } catch {}
  }
}

// The app terminates the helper when installer startup or its own quit fallback
// gives up; honour that only while nothing has been moved yet.
process.on('SIGTERM', () => {
  if (committed) return
  log('install cancelled by the running app before it quit')
  writeResult({ ok:false,cancelled:true,error:'应用未能正常退出，安装已取消' })
  try { if (config?.stageRoot) fs.rmSync(config.stageRoot,{ recursive:true,force:true }) } catch {}
  try { if (configPath) fs.rmSync(configPath,{ force:true }) } catch {}
  process.exit(1)
})

run().catch(error => {
  log(`installer stopped: ${error.stack || error.message}`)
  // Keep a more specific result (e.g. rollbackPending with backup paths).
  if (!resultWritten) writeResult({ ok:false,error:error.message })
  try { if (config?.stageRoot) fs.rmSync(config.stageRoot,{ recursive:true,force:true }) } catch {}
  try { if (configPath) fs.rmSync(configPath,{ force:true }) } catch {}
  process.exitCode = 1
})
