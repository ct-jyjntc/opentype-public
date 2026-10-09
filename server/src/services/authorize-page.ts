// 授权页 HTML。
//
// 存在的理由：客户端点击「使用电子邮件继续」会打开
// /login/app/auth?code_challenge=...&state=...&next=/login/email，
// 用户在这里登录后，服务端签发授权码并重定向回客户端深链接。
//
// 自包含单页（内联样式与脚本）：授权页是登录流程的一部分，
// 不应依赖外部资源——网络慢时白屏会直接卡死登录。
//
// 安全要点：
// - code_challenge 与 state 原样透传，不在服务端存储时改动
// - 授权码一次性，兑换时校验 PKCE
// - 表单用 POST，密码不进 URL

export interface AuthorizePageParams {
  codeChallenge: string
  state: string
  next: string
  /** 回调地址。优先本地 HTTP（开发态深链接不可用）。 */
  redirectUri?: string
  /** 出错时展示的提示 */
  error?: string
  /** 是否注册模式 */
  register?: boolean
}

/** HTML 转义，防止 next 参数注入脚本。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/**
 * 模式切换（登录↔注册）必须用 GET 链接，不能用 POST 表单。
 *
 * 用 POST 会把「切换」当成一次登录/注册提交：表单里没有邮箱密码，
 * 服务端拿到空邮箱 → 触发校验失败 → 用户还没开始填就看到报错。
 * 这是实际发生过的 bug。
 */
export function renderAuthorizePage(p: AuthorizePageParams): string {
  const isRegister = Boolean(p.register)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${isRegister ? '注册' : '登录'} · OpenType</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: linear-gradient(160deg, #eef2f7 0%, #dbe4f0 100%);
    color: #1a1a1c;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: #fff;
    border-radius: 16px;
    padding: 32px 28px;
    box-shadow: 0 12px 40px rgba(20, 30, 60, 0.12);
  }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
  label { display: block; font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  input {
    width: 100%;
    padding: 11px 13px;
    font-size: 14px;
    border: 1px solid #d8dde6;
    border-radius: 9px;
    outline: none;
    transition: border-color .15s;
    margin-bottom: 14px;
  }
  input:focus { border-color: #1a1a1c; }
  button {
    width: 100%;
    padding: 12px;
    font-size: 14px;
    font-weight: 500;
    color: #fff;
    background: #1a1a1c;
    border: none;
    border-radius: 9px;
    cursor: pointer;
    margin-top: 4px;
  }
  button:disabled { opacity: .5; cursor: default; }
  .link {
    display: block;
    width: 100%;
    margin-top: 16px;
    color: #2563eb;
    font-size: 13px;
    text-align: center;
    cursor: pointer;
    text-decoration: underline;
  }
  .err {
    padding: 10px 12px;
    margin-bottom: 16px;
    font-size: 13px;
    color: #b42318;
    background: #fef3f2;
    border-radius: 8px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${isRegister ? '创建账号' : '登录 OpenType'}</h1>
    <p class="sub">${isRegister ? '注册后自动登录并返回应用' : '登录后将返回 OpenType 应用'}</p>
    ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
    <form method="POST" action="/login/app/auth">
      <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}" />
      <input type="hidden" name="state" value="${esc(p.state)}" />
      <input type="hidden" name="next" value="${esc(p.next)}" />
      <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri ?? '')}" />
      <input type="hidden" name="mode" value="${isRegister ? 'register' : 'login'}" />
      <label for="email">邮箱</label>
      <input id="email" name="email" type="email" required autocomplete="username"
             placeholder="you@example.com" autofocus />
      <label for="password">密码</label>
      <input id="password" name="password" type="password" required
             minlength="${isRegister ? 8 : 1}"
             autocomplete="${isRegister ? 'new-password' : 'current-password'}"
             placeholder="${isRegister ? '至少 8 位' : ''}" />
      <button type="submit">${isRegister ? '注册并继续' : '登录'}</button>
    </form>
    <a class="link" href="/login/app/auth?code_challenge=${encodeURIComponent(p.codeChallenge)}&state=${encodeURIComponent(p.state)}&next=${encodeURIComponent(p.next)}&mode=${isRegister ? 'login' : 'register'}${p.redirectUri ? `&redirect_uri=${encodeURIComponent(p.redirectUri)}` : ''}">
      ${isRegister ? '已有账号？去登录' : '没有账号？去注册'}
    </a>
  </div>
</body>
</html>`
}
