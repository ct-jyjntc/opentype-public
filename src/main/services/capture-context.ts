import type { InputSnapshot } from './input-delivery'
import type { CaptureTarget } from './capture-session'
import { voiceContext } from './voice-context'

/** Use only the captured element's context and document chain. A containing
 * document's privacy restriction also applies to an embedded editor. */
export function capturedContext(target: InputSnapshot, blacklistDomains: string[]): CaptureTarget {
  const urls = target.webUrls?.length ? target.webUrls : [target.webUrl ?? '']
  const fields = { app_name: target.appName, bundle_id: target.bundleId, role: target.role }
  const blocked = urls.some(web_url => voiceContext({ ...fields, web_url }, {}, blacklistDomains).redacted)
  const context = voiceContext({ ...fields, input_context: target.contextText, web_url: target.webUrl,
    redacted: target.contextRedacted === true || blocked }, {}, blacklistDomains)
  return { appName: target.appName, bundleId: target.bundleId, audioContext: context,
    selectedText: context.redacted ? '' : target.selectedText ?? '', inputToken: target.token, inputError: target.reason,
    inputWebDomains: [...new Set(urls.flatMap(url => { try { const host = new URL(url).hostname; return host ? [host] : [] } catch { return [] } }))] }
}
