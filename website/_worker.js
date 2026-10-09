const MODEL_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const MODEL_PREFIX = `/downloads/models/sensevoice-int8/${MODEL_REVISION}/`;
const DOWNLOADS = { '/downloads/macos-arm64': { key: 'mac', suffix: 'macOS-arm64.dmg' },
  '/downloads/windows-x64': { key: 'win', suffix: 'Windows-x64.exe' } };
const UPSTREAM_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'api.opentype.top']);

function fail(status, message) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

async function streamFile(request, upstream, filename, immutable = false) {
  const headers = new Headers({ 'user-agent': 'OpenType/website-downloads' });
  // Only a single byte range is supported. Do not forward cookies, tokens, or
  // arbitrary incoming headers to a release host.
  const range = request.headers.get('range');
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return fail(416, '不支持此下载范围。');
  if (range) headers.set('range', range);
  if (request.headers.has('if-range')) headers.set('if-range', request.headers.get('if-range'));
  let response;
  for (let hop = 0; hop < 5; hop++) {
    const destination = new URL(upstream);
    if (destination.protocol !== 'https:' || !UPSTREAM_HOSTS.has(destination.hostname)) return fail(502, '下载服务暂不可用。');
    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 30000);
    try {
      response = await fetch(destination, { method: request.method, headers, redirect: 'manual', signal: controller.signal });
    } catch { return fail(502, '下载服务连接失败，请稍后重试。'); }
    finally { clearTimeout(connectionTimeout); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location');
    await response.body?.cancel();
    if (!next) return fail(502, '下载服务暂不可用。');
    upstream = new URL(next, destination).href;
  }
  if (!response || ![200, 206, 416].includes(response.status)) return fail(response?.status === 404 ? 404 : 502, '下载文件暂不可用，请稍后重试。');
  const outgoing = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (response.headers.has(name)) outgoing.set(name, response.headers.get(name));
  }
  outgoing.set('content-disposition', `attachment; filename="${filename}"`);
  outgoing.set('x-content-type-options', 'nosniff');
  outgoing.set('cache-control', immutable && response.status !== 416 ? 'public, max-age=31536000, immutable' : 'no-store');
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outgoing });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, '仅支持读取请求。');
    if (url.pathname.startsWith(MODEL_PREFIX)) {
      const file = url.pathname.slice(MODEL_PREFIX.length);
      if (!['model.int8.onnx', 'tokens.txt'].includes(file) || url.search) return fail(404, '文件不存在。');
      return streamFile(request, `https://api.opentype.top${MODEL_PREFIX}${file}`, file, true);
    }
    if (DOWNLOADS[url.pathname]) {
      if (url.search) return fail(404, '文件不存在。');
      const info = DOWNLOADS[url.pathname];
      const manifestResponse = await env.ASSETS.fetch(new Request(new URL('/downloads/manifest.json', url)));
      const manifest = await manifestResponse.json();
      if (!/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(manifest.version || '') || !manifest.files?.[info.key]) return fail(404, '该平台安装包暂未提供。');
      const filename = `OpenType-${manifest.version}-${info.suffix}`;
      return streamFile(request, `https://github.com/ct-jyjntc/opentype-public/releases/download/v${manifest.version}/${filename}`, filename);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    if (url.pathname.startsWith('/auth/')) {
      headers.set('cache-control', 'no-store');
      headers.set('content-security-policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    }
    if (url.pathname === '/downloads/manifest.json') headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  },
};
