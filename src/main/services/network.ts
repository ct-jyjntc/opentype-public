import { request } from 'undici'
import { serviceEndpoint } from '../../shared/network-policy'

/** undici.request does not follow redirects. Reject them explicitly instead of parsing a login/result body. */
export async function serviceRequest(url: string | URL, options: Parameters<typeof request>[1]) {
  const response = await request(serviceEndpoint(String(url)), options)
  if (response.statusCode >= 300 && response.statusCode < 400) {
    await response.body.dump()
    throw new Error('service_redirect_refused')
  }
  return response
}
