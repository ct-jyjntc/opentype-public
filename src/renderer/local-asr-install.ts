import type { ModelStatus } from '../main/services/local-asr/model-store'

/** Shared local-model install/enable helpers for speech settings and N1 cold-start. */
export type LocalInstallOutcome = 'ready' | 'cancelled' | 'error'

export function busyModelState(status?: ModelStatus) {
  return status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'checking'
}

export function progressPercent(status?: ModelStatus) {
  if (!status?.total) return 0
  return Math.min(100, Math.floor((status.downloaded / status.total) * 100))
}

/**
 * Run localAsr.install (bundle SHA check / download). Does NOT write provider.
 * Caller enables local only after ready via speech.setRecognitionProvider.
 */
export async function runLocalAsrInstall(options: {
  onStatus?: (status: ModelStatus) => void
  isCancelled?: () => boolean
}): Promise<{ outcome: LocalInstallOutcome; status?: ModelStatus; error?: string }> {
  options.onStatus?.({ state: 'checking', downloaded: 0, total: 239549735 })
  try {
    const status = await window.opentype.localAsr.install()
    options.onStatus?.(status)
    if (options.isCancelled?.()) return { outcome: 'cancelled', status }
    if (status.state !== 'ready') {
      return { outcome: 'error', status, error: status.error || '模型尚未准备完成，请重试。' }
    }
    return { outcome: 'ready', status }
  } catch (error) {
    return { outcome: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function cancelLocalAsrInstall() {
  await window.opentype.localAsr.cancel()
}

/** Unique write path: only after localAsr.check() === ready. */
export async function enableLocalRecognitionProvider() {
  const status = await window.opentype.localAsr.check()
  if (status.state !== 'ready') throw new Error(status.error || 'model_not_ready')
  return window.opentype.speech.setRecognitionProvider('local')
}
