// 邮件通道。
//
// 通过环境变量配置通用 HTTP 邮件网关：
//   MAIL_API_URL  邮件服务地址（POST JSON {from,to,subject,text}）
//   MAIL_API_KEY  可选，Authorization: Bearer
//   MAIL_FROM     发件人地址
//
// No recipient, verification code or upstream error body is logged.
// A false result must become a visible delivery failure in production.

import { serviceEndpoint } from './network-policy.ts'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export function mailConfigured(): boolean {
  return Boolean(process.env.MAIL_API_URL && process.env.MAIL_FROM)
}

export function developmentEmailCodesAllowed(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_EMAIL_CODES === 'true'
    && ['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST ?? '127.0.0.1')
}

export async function sendMail(message: MailMessage): Promise<boolean> {
  const url = process.env.MAIL_API_URL
  const from = process.env.MAIL_FROM
  const key = process.env.MAIL_API_KEY

  if (!url || !from) {
    // Development login returns dev_code through the API. Never write codes or recipients to logs.
    console.log('[mail] 邮件通道未配置')
    return false
  }

  try {
    const res = await fetch(serviceEndpoint(url), {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({ from, to: message.to, subject: message.subject, text: message.text })
    })
    if (!res.ok) {
      console.error(`[mail] 发送失败：HTTP ${res.status}`)
      return false
    }
    return true
  } catch {
    console.error('[mail] 邮件投递失败')
    return false
  }
}

/** 验证码邮件（登录/重置共用）。 */
export async function sendCodeMail(to: string, code: string, purpose: 'login' | 'password_reset'): Promise<boolean> {
  const subject = purpose === 'password_reset'
    ? 'OpenType password reset code'
    : 'OpenType verification code'
  const text = purpose === 'password_reset'
    ? `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`
    : `Your verification code is ${code}. It expires in 10 minutes.`
  return sendMail({ to, subject, text })
}
