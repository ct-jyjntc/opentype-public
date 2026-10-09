/** Shared pure policy. Lives in the standalone server tree so deployments remain self-contained. */
/** Canonical identity for a configured API service. Invalid saved values stay editable. */
export function serviceScope(value: string): string {
  try { return new URL(value.trim()).toString().replace(/\/+$/, '') }
  catch { return value.trim().replace(/\/+$/, '') }
}

/** Validate before obtaining credentials or issuing a request. Never include rejected URLs in errors. */
export function serviceEndpoint(baseUrl: string, path = '', localOnly = false): string {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('cloud_not_configured')
  let url: URL
  try { url = new URL(baseUrl.trim()) } catch { throw new Error('invalid_cloud_url') }
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid_cloud_url')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (localOnly && !loopback) throw new Error('invalid_local_endpoint')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('insecure_cloud_url')
  if (path && (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#'))) throw new Error('invalid_api_path')
  return serviceScope(baseUrl) + path
}

/** Account tokens may only accompany requests to the account service, including its base path. */
export async function serviceToken(destination: string, issuer: string, getToken: () => Promise<string | null>): Promise<string | null> {
  serviceEndpoint(destination)
  if (!issuer || serviceScope(destination) !== serviceScope(issuer)) return null
  return getToken()
}

/** Changing a service never silently reuses a credential belonging to the previous service. */
export function networkSettingsPatch<T extends { apiBaseUrl?: string; cloudBaseUrl?: string; apiKey?: string }>(current: T, patch: Partial<T>): Partial<T> {
  const next = { ...patch }
  for (const key of ['apiBaseUrl', 'cloudBaseUrl'] as const) {
    if (!(key in next)) continue
    if (typeof next[key] !== 'string') throw new Error('invalid_cloud_url')
    if (key === 'cloudBaseUrl' && !next[key]!.trim()) { next[key] = '' as T[typeof key]; continue }
    next[key] = serviceEndpoint(next[key]!) as T[typeof key]
  }
  if (next.apiBaseUrl !== undefined && serviceScope(next.apiBaseUrl) !== serviceScope(current.apiBaseUrl ?? '') && next.apiKey === undefined) {
    next.apiKey = '' as T['apiKey']
  }
  return next
}
