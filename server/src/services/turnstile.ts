import { createHash } from 'node:crypto'
import { HttpError } from '../http.ts'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const EXPECTED_HOSTNAME = 'www.opentype.top'
const PAGE_URL = `https://${EXPECTED_HOSTNAME}/auth/verify`
export type ChallengeAction = 'login' | 'register'
const consumed = new Map<string, number>()

export function challengeRequired(): boolean {
  // A development-only switch cannot disable production account protection.
  return process.env.NODE_ENV === 'production' || process.env.TURNSTILE_REQUIRED !== 'false'
}

export function validateChallengeConfiguration(): void {
  if (challengeRequired() && (!process.env.TURNSTILE_SECRET_KEY?.trim() || !process.env.TURNSTILE_SITE_KEY?.trim())) {
    throw new Error('turnstile_configuration_required')
  }
}

export function challengeConfiguration() {
  return { required: challengeRequired(), siteKey: process.env.TURNSTILE_SITE_KEY ?? '', pageUrl: PAGE_URL }
}

/** Verify every new credential exchange, without storing or logging the token. */
export async function verifyChallenge(token: unknown, action: ChallengeAction, remoteIp: string): Promise<void> {
  if (!challengeRequired()) return
  if (typeof token !== 'string' || !token || token.length > 2048 || /\s/.test(token)) throw new HttpError(403, 'challenge_required')
  const now = Date.now()
  for (const [hash, expires] of consumed) if (expires <= now) consumed.delete(hash)
  const fingerprint = createHash('sha256').update(token).digest('hex')
  if (consumed.has(fingerprint)) throw new HttpError(403, 'challenge_expired')
  if (consumed.size >= 10_000) throw new HttpError(503, 'challenge_unavailable')
  let result: Record<string, unknown>
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY!, response: token, remoteip: remoteIp })
    })
    if (!response.ok) throw new Error('siteverify_unavailable')
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('siteverify_invalid_response')
    result = payload as Record<string, unknown>
  } catch { throw new HttpError(503, 'challenge_unavailable') }
  const issuedAt = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN
  if (result.success !== true || result.hostname !== EXPECTED_HOSTNAME || result.action !== action
    || !Number.isFinite(issuedAt) || now - issuedAt > 300_000 || issuedAt - now > 30_000) {
    const codes = result['error-codes']
    throw new HttpError(403, Array.isArray(codes) && codes.includes('timeout-or-duplicate') ? 'challenge_expired' : 'challenge_invalid')
  }
  // Also protect simultaneous requests after Siteverify returns, and never retain plaintext tokens.
  if (consumed.has(fingerprint)) throw new HttpError(403, 'challenge_expired')
  consumed.set(fingerprint, now + 300_000)
}
