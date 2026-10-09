(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const requestId = params.get('request_id');
  const action = params.get('action');
  const message = document.getElementById('status');
  const retry = document.getElementById('retry');
  const valid = location.origin === 'https://www.opentype.top'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || '')
    && ['login', 'register'].includes(action);
  let widget;
  function send(status, token) {
    if (window.parent === window || !valid) return;
    // Electron's file:// parent has an opaque origin. The parent validates this
    // document's HTTPS origin, source window, random request ID, and action.
    window.parent.postMessage({ type: 'opentype:turnstile', requestId, action, status,
      ...(typeof token === 'string' ? { token } : {}) }, '*');
  }
  window.onTurnstileReady = () => {
    if (!valid) { message.textContent = '请从 OpenType 的登录或注册界面打开验证。'; return; }
    message.textContent = '请完成下面的安全验证。';
    widget = window.turnstile.render('#challenge', {
      sitekey: '0x4AAAAAAFSeaJwY-fxE1JfZ', action, cData: requestId,
      theme: 'auto', size: 'flexible',
      callback(token) { message.textContent = '验证完成，可以继续。'; retry.hidden = true; send('token', token); },
      'expired-callback'() { message.textContent = '验证已过期，请重新验证。'; retry.hidden = false; send('expired'); },
      'error-callback'() { message.textContent = '验证暂不可用，请检查网络后重试。'; retry.hidden = false; send('error'); },
      'timeout-callback'() { message.textContent = '验证超时，请重试。'; retry.hidden = false; send('error'); },
    });
    send('ready');
  };
  retry.addEventListener('click', () => {
    if (widget !== undefined && window.turnstile) { send('expired'); window.turnstile.reset(widget); retry.hidden = true; }
  });
  setTimeout(() => {
    if (widget === undefined && valid) {
      message.textContent = '安全验证未能加载，请在 OpenType 中重试。'; send('error');
    }
  }, 15000);
})();
