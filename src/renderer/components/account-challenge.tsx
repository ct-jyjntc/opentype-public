import { useEffect, useMemo, useRef, useState } from 'react'
import { AUTH_CHALLENGE_ORIGIN, AUTH_CHALLENGE_PAGE, type AuthChallengeAction, type AuthChallengeConfiguration } from '../../shared/auth-challenge'
import { errorMessage } from '../../shared/desktop'

/** Remote content receives only a random correlation ID and a public action. */
export function AccountChallenge({ action, disabled, onToken }: {
  action: AuthChallengeAction
  disabled: boolean
  onToken: (token: string | null) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const callback = useRef(onToken); callback.current = onToken
  const [attempt, setAttempt] = useState(0)
  const requestId = useMemo(() => crypto.randomUUID(), [action, attempt])
  const [config, setConfig] = useState<AuthChallengeConfiguration>()
  const [status, setStatus] = useState<'loading'|'waiting'|'verified'|'expired'|'error'|'disabled'>('loading')
  const [detail, setDetail] = useState('')
  const expiry = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    let active = true
    callback.current(null); setConfig(undefined); setDetail(''); setStatus('loading')
    void window.opentype.auth.challengeConfiguration().then(value => {
      if (!active) return
      if (value.pageUrl !== AUTH_CHALLENGE_PAGE) throw new Error('challenge_unavailable')
      setConfig(value)
      if (!value.required) { setStatus('disabled'); callback.current('') }
    }).catch(error => {
      if (active) { setStatus('error'); setDetail(errorMessage(error)) }
    })
    return () => { active = false; clearTimeout(expiry.current); callback.current(null) }
  }, [requestId])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== AUTH_CHALLENGE_ORIGIN || event.source !== frame.current?.contentWindow) return
      const data: unknown = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return
      const message = data as Record<string, unknown>
      if (message.type !== 'opentype:turnstile' || message.requestId !== requestId || message.action !== action) return
      if (message.status === 'ready') {
        setStatus(current => current === 'loading' ? 'waiting' : current)
        return
      }
      if (message.status === 'token' && typeof message.token === 'string' && message.token.length > 0
        && message.token.length <= 2048 && !/\s/.test(message.token)) {
        clearTimeout(expiry.current)
        callback.current(message.token); setStatus('verified'); setDetail('')
        expiry.current = setTimeout(() => { callback.current(null); setStatus('expired') }, 240_000)
      } else if (message.status === 'expired' || message.status === 'error') {
        clearTimeout(expiry.current)
        callback.current(null); setStatus(message.status)
        setDetail(message.status === 'error' ? '验证没有完成，请重试' : '')
      }
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive); clearTimeout(expiry.current) }
  }, [action, requestId])

  useEffect(() => {
    if (!config?.required || status !== 'loading') return
    const timer = setTimeout(() => { callback.current(null); setStatus('error'); setDetail('验证加载超时，请重试') }, 30_000)
    return () => clearTimeout(timer)
  }, [config, status])

  if (status === 'disabled') return null
  const src = `${AUTH_CHALLENGE_PAGE}?request_id=${encodeURIComponent(requestId)}&action=${action}`
  const note = status === 'verified' ? '' : status === 'expired' ? '验证已过期' : status === 'error' ? detail || '验证暂时不可用'
    : status === 'loading' ? '正在加载验证…' : ''
  return <div className="challenge" aria-label="账户安全验证">
    {config?.required && <iframe ref={frame} key={requestId} src={src} title="Cloudflare 安全验证"
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
    {note && <p role="status" className="challenge-note">{note}
      {(status === 'expired' || status === 'error') && <button type="button" className="link" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重新验证</button>}
    </p>}
  </div>
}
