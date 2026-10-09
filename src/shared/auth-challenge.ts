export type AuthChallengeAction = 'login' | 'register'
export interface AuthChallengeConfiguration { required: boolean; siteKey: string; pageUrl: string }
export const AUTH_CHALLENGE_PAGE = 'https://www.opentype.top/auth/verify'
export const AUTH_CHALLENGE_ORIGIN = 'https://www.opentype.top'
