/** Public GETs may follow CDN redirects, but never downgrade to HTTP or carry credentials. */
export async function fetchPublicHttps(input: string, options: { signal?: AbortSignal; userAgent?: string; accept?: string } = {}): Promise<Response> {
  let url = new URL(input)
  for (let redirects = 0; redirects <= 8; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('insecure_download_url')
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal: options.signal,
      headers: { ...(options.userAgent ? { 'user-agent': options.userAgent } : {}), ...(options.accept ? { accept: options.accept } : {}) },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 8) throw new Error('download_redirect_failed')
    url = new URL(location, url)
  }
  throw new Error('download_redirect_failed')
}
