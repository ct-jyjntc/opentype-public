/** The full API base is part of account identity, including installations under a path. */
import { serviceEndpoint } from '../../shared/network-policy'
export { serviceScope as syncScope } from '../../shared/network-policy'

export function assertSecureSyncUrl(baseUrl: string): void {
  serviceEndpoint(baseUrl)
}
