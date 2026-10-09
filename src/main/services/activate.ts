// 跨平台应用激活。
//
// 三平台各有一套实现，且都有兜底路径。
// 为什么需要它：录音期间用户可能切走窗口，注入前必须把焦点交还给原目标应用，
// 否则文本会打进错误的窗口。macOS 的 AX API 能直接设焦点，但跨平台时不可用。

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ActivateResult {
  ok: boolean
  method: 'applescript' | 'open-b' | 'powershell' | 'wmctrl' | 'gtk-launch' | 'none'
  detail?: string
}

/**
 * macOS：AppleScript 优先，`open -b` 兜底。
 *
 * AppleScript 的 `tell application id` 对没有 AppleScript 字典的应用会报错，
 * 此时 `open -b <bundleId>` 仍能激活（它走 Launch Services）。
 * 两层都失败才算失败。
 */
async function activateOnMacOS(bundleId: string): Promise<ActivateResult> {
  const script = `
try
  tell application id "${bundleId}"
    if it is running then
      activate
    else
      launch
    end if
  end tell
on error
  do shell script "open -b ${bundleId}"
end try`

  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 3000 })
    return { ok: true, method: 'applescript' }
  } catch (err) {
    // osascript 失败时直接试 open -b（脚本内的 on error 已兜底，这里防脚本本身语法失败）
    try {
      await execFileAsync('open', ['-b', bundleId], { timeout: 3000 })
      return { ok: true, method: 'open-b' }
    } catch (err2) {
      return { ok: false, method: 'none', detail: (err2 as Error).message ?? String(err) }
    }
  }
}

/**
 * Windows：PowerShell + WScript.Shell.AppActivate。
 *
 * 关键点是 `Where-Object { $_.MainWindowHandle -ne 0 }`——
 * 同名进程可能有多个（后台服务 + 前台窗口），只激活有主窗口的那个。
 * 退出码：0=成功 1=激活失败 2=进程不存在。
 */
async function activateOnWindows(appName: string): Promise<ActivateResult> {
  const name = appName.replace(/\.exe$/i, '')
  const script = `
$name = "${name}";
$proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1;
if ($proc) {
  $wshell = New-Object -ComObject WScript.Shell;
  $success = $wshell.AppActivate($proc.Id);
  if ($success) { exit 0 } else { exit 1 }
} else {
  exit 2
}`

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 })
    return { ok: true, method: 'powershell' }
  } catch (err) {
    const code = (err as { code?: number }).code
    return {
      ok: false,
      method: 'powershell',
      detail: code === 2 ? 'process_not_found' : code === 1 ? 'activate_rejected' : String(err)
    }
  }
}

/** Linux：wmctrl 优先，gtk-launch 兜底。 */
async function activateOnLinux(appName: string): Promise<ActivateResult> {
  try {
    await execFileAsync('wmctrl', ['-a', appName], { timeout: 3000 })
    return { ok: true, method: 'wmctrl' }
  } catch {
    try {
      await execFileAsync('gtk-launch', [appName], { timeout: 3000 })
      return { ok: true, method: 'gtk-launch' }
    } catch (err) {
      return { ok: false, method: 'none', detail: (err as Error).message }
    }
  }
}

/**
 * 静默激活目标应用（不弹出、不抢用户当前操作之外的东西）。
 * identifier 在 macOS 是 bundle id，在 Windows/Linux 是应用名或可执行文件名。
 */
export async function activateAppSilently(identifier: string): Promise<ActivateResult> {
  if (!identifier) return { ok: false, method: 'none', detail: 'empty_identifier' }

  switch (platform()) {
    case 'darwin': return activateOnMacOS(identifier)
    case 'win32': return activateOnWindows(identifier)
    case 'linux': return activateOnLinux(identifier)
    default: return { ok: false, method: 'none', detail: 'unsupported_platform' }
  }
}

/**
 * 同步等待激活完成。
 *
 * 注入前需要阻塞极短时间让窗口系统完成焦点切换。
 * 用 Atomics.wait 而非忙等：忙等会占满 CPU 且不精确。
 */
export function waitForActivation(ms = 120): void {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}
