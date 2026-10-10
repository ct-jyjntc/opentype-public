import { OFFICIAL_BACKEND_URL } from '../../shared/official-backend'
import { serviceEndpoint } from '../../shared/network-policy'

interface AccountConfigStore {
  get(key: string): unknown
  set(values: Record<string, unknown>): void
  /** Distinguishes an undecryptable persisted secret from a missing one (both read back as empty). */
  isUndecryptable?(key: string): boolean
}

/** Set when the migration could not scrub the foreign session out of an undecryptable app-storage. */
const SCRUB_PENDING_KEY = 'appStorageScrubPending'

/** Remove the foreign renderer session once app-storage decrypts again, then clear the marker. */
function scrubAppStorage(store: AccountConfigStore): boolean {
  if (store.isUndecryptable?.('app-storage') === true) return false
  const rendererStorage = store.get('app-storage')
  const retainedStorage = rendererStorage && typeof rendererStorage === 'object' && !Array.isArray(rendererStorage)
    ? { ...rendererStorage as Record<string, unknown> } : {}
  delete retainedStorage.userData
  store.set({ 'app-storage': retainedStorage })
  return true
}

/** Run before auth initialization. Never contact the old server while migrating. */
export function migrateOfficialBackend(store: AccountConfigStore): void {
  if (store.get(SCRUB_PENDING_KEY) === true && scrubAppStorage(store)) store.set({ [SCRUB_PENDING_KEY]: false })
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
  // An undecryptable app-storage reads back as {}; writing that would destroy the
  // ciphertext the OS key store may unlock later, so leave it intact.
  // A later launch scrubs it via SCRUB_PENDING_KEY once decryption works.
  const keepEncryptedStorage = store.isUndecryptable?.('app-storage') === true
  const rendererStorage = keepEncryptedStorage ? undefined : store.get('app-storage')
  const retainedStorage = rendererStorage && typeof rendererStorage === 'object' && !Array.isArray(rendererStorage)
    ? { ...rendererStorage as Record<string, unknown> } : {}
  delete retainedStorage.userData
  store.set({
    cloudBaseUrl: OFFICIAL_BACKEND_URL,
    userData: '',
    ...(keepEncryptedStorage ? { [SCRUB_PENDING_KEY]: true } : { 'app-storage': retainedStorage }),
    syncBlockedUsers: blocked,
    accountBackendMigrationScope: store.get('accountBackendMigrationScope') || previousScope,
  })
}
