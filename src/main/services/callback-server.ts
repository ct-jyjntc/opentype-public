// 本地 OAuth 回调服务。
//
// 存在的理由：开发态下 `opentype://` 深链接无法工作 ——
// Electron 注册的 bundle id 是 com.github.electron，系统无法区分是哪个应用，
// 表现为「浏览器授权完成后跳回链接但应用毫无反应」。
//
// 方案：主进程起一个只监听 127.0.0.1 的 HTTP 服务，授权页完成后直接请求它。
// 这比深链接更可靠：不依赖系统协议注册，开发态与打包后行为一致。
//
// 安全约束：
// - 只监听 127.0.0.1，外部无法访问
// - 端口随机（避免与其他服务冲突）
// - 校验 state，防 CSRF
// - 收到有效回调后立即处理并返回一个「可以关闭」的提示页

import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

export interface CallbackServerOptions {
  /** 收到授权码时的处理。返回是否成功。 */
  onCallback: (params: { code: string; state: string }) => Promise<{ success: boolean; detail?: string }>
}

export interface CallbackServer {
  port: number
  close: () => void
}

/** 返回给浏览器的提示页。 */
function resultPage(ok: boolean, detail?: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${ok ? '登录成功' : '登录失败'} · OpenType</title>
<style>
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: linear-gradient(160deg, #eef2f7 0%, #dbe4f0 100%);
    color: #1a1a1c;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 40px 48px;
    box-shadow: 0 12px 40px rgba(20,30,60,.12); text-align: center;
    max-width: 360px;
  }
  .icon { font-size: 40px; margin-bottom: 12px; }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 13px; color: #6b7280; margin: 0; line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${ok ? '✓' : '✕'}</div>
    <h1>${ok ? '登录成功' : '登录失败'}</h1>
    <p>${ok
      ? '已返回 OpenType 应用，可以关闭此页面。'
      : (detail ? `原因：${detail}` : '请返回应用重试。')}</p>
  </div>
  <script>setTimeout(() => window.close(), ${ok ? 1200 : 4000})</script>
</body>
</html>`
}

/**
 * 启动回调服务。端口用 0 让系统分配空闲端口，避免冲突。
 */
export function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)

      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(resultPage(false, error))
        return
      }
      if (!code || !state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(resultPage(false, '缺少 code 或 state'))
        return
      }

      const result = await options.onCallback({ code, state })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(resultPage(result.success, result.detail))
    })

    server.on('error', reject)
    // 只监听回环地址：外部网络无法访问
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        close: () => { server.close() }
      })
    })
  })
}
