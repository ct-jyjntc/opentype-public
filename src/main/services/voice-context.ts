import type { HistoryRow } from '../db'
import { decideContext } from './privacy'

export function jsonObject(value: unknown): Record<string, unknown> {
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value)
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const str = (value: unknown): string => typeof value === 'string' ? value : ''

/** Normalize only approved fields; never forward the renderer's complete context object. */
export function voiceContext(value: unknown, row: Partial<HistoryRow> = {}, blacklist: string[] = []) {
  const raw = jsonObject(value)
  const application = jsonObject(raw.active_application)
  const insertion = jsonObject(raw.text_insertion_point)
  const cursor = jsonObject(insertion.cursor_state)
  const appName = str(raw.app_name ?? application.app_name ?? row.focusedAppName)
  const bundleId = str(raw.bundle_id ?? application.app_identifier ?? row.focusedAppBundleId)
  const url = str(raw.web_url ?? insertion.web_url ?? row.focusedAppWebUrl)
  let domain = str(raw.web_domain ?? row.focusedAppWebDomain).toLowerCase()
  try { if (url) domain = new URL(url).hostname.toLowerCase() } catch { /* no URL */ }
  const role = str(insertion.role ?? raw.role)
  const decision = decideContext(bundleId, domain, url, appName)
  const blockedDomain = blacklist.some(entry => {
    const d = entry.trim().toLowerCase().replace(/^\./, '')
    return d && (domain === d || domain.endsWith(`.${d}`))
  })
  const secure = /secure|password/i.test(role)
  const redacted = raw.redacted === true || secure || blockedDomain || !decision.allowContext
  return {
    app_name: appName,
    bundle_id: bundleId,
    window_title: redacted ? '' : str(raw.window_title ?? application.window_title ?? row.focusedAppWindowTitle),
    web_url: redacted ? '' : url,
    web_domain: redacted ? '' : domain,
    input_context: redacted ? '' : str(raw.input_context ?? cursor.surrounding_text ?? row.inputContext).slice(-2000),
    redacted,
    redact_reason: redacted ? (secure ? 'secure_input' : blockedDomain ? 'remote_blacklist' : decision.reason) : null
  }
}
