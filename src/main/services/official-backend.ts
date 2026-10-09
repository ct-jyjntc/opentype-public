import { OFFICIAL_BACKEND_URL } from '../../shared/official-backend'
import { serviceEndpoint } from '../../shared/network-policy'

interface AccountConfigStore {
  get(key: string): unknown
  set(values: Record<string, unknown>): void
}

/** Run before auth initialization. Never contact the old server while migrating. */
export function migrateOfficialBackend(store: AccountConfigStore): void {
  const previous = store.get('cloudBaseUrl')
  let previousScope = 'local:before-official-backend'
  try { previousScope = serviceEndpoint(typeof previous === 'string' ? previous : '') } catch { /* local-only or invalid legacy value */ }
  const blocked = { ...((store.get('syncBlockedUsers') ?? {}) as Record<string, boolean>) }
  for (const [userId, disabled] of Object.entries(blocked)) {
    if (!userId.includes('\n')) {
      if (disabled === true) blocked[`${previousScope}\n${userId}`] = true
      delete blocked[userId]
    }
  }
  if (previousScope === OFFICIAL_BACKEND_URL) {
    store.set({ cloudBaseUrl: OFFICIAL_BACKEND_URL, syncBlockedUsers: blocked })
    return
  }
  // Persist the DB work marker with the credential reset so a crash can resume
  // without ever reusing a foreign session or claiming its unscoped history.
  const rendererStorage = store.get('app-storage')
  const retainedStorage = rendererStorage && typeof rendererStorage === 'object' && !Array.isArray(rendererStorage)
    ? { ...rendererStorage as Record<string, unknown> } : {}
  delete retainedStorage.userData
  store.set({
    cloudBaseUrl: OFFICIAL_BACKEND_URL,
    userData: '',
    'app-storage': retainedStorage,
    syncBlockedUsers: blocked,
    accountBackendMigrationScope: store.get('accountBackendMigrationScope') || previousScope,
  })
}
