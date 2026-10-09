/** Encrypt credential-bearing config values with the OS key store before they reach disk. */
export interface ConfigBackend {
  store: Record<string, unknown>
  set(values: Record<string, unknown>): void
}

export interface SecretEncryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type Envelope = { opentypeEncrypted: 1; ciphertext: string }
export type SecretStorageIssue = 'session_only' | 'decrypt_failed'

// app-storage contains the legacy renderer's own userData/session copy.
const PROTECTED_KEYS = new Set(['apiKey', 'refineApiKey', 'userData', 'app-storage'])
const emptyValue = (key: string): unknown => key === 'app-storage' ? {} : ''
const isEmpty = (value: unknown) => value == null || value === ''
const isEnvelope = (value: unknown): value is Envelope => !!value && typeof value === 'object'
  && (value as Envelope).opentypeEncrypted === 1 && typeof (value as Envelope).ciphertext === 'string'

export class SecureConfigStore {
  private sessionValues = new Map<string, unknown>()
  private reported = new Set<SecretStorageIssue>()

  constructor(
    private readonly backend: ConfigBackend,
    private readonly encryption: SecretEncryption,
    private readonly onIssue: (issue: SecretStorageIssue) => void = () => {}
  ) {
    // One atomic backend write migrates existing plaintext. Never create a plaintext backup.
    const migrated: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(backend.store)) {
      if (PROTECTED_KEYS.has(key) && !isEmpty(value) && !isEnvelope(value)) {
        migrated[key] = this.encode(key, value)
      }
    }
    if (Object.keys(migrated).length) backend.set(migrated)
  }

  get store(): Record<string, unknown> {
    const result = { ...this.backend.store }
    for (const key of PROTECTED_KEYS) {
      if (key in result || this.sessionValues.has(key)) result[key] = this.get(key)
    }
    return result
  }

  get(key: string): unknown {
    if (this.sessionValues.has(key)) return structuredClone(this.sessionValues.get(key))
    const value = this.backend.store[key]
    if (!PROTECTED_KEYS.has(key) || !isEnvelope(value)) return value
    try {
      if (!this.available()) throw new Error('key_store_unavailable')
      return JSON.parse(this.encryption.decryptString(Buffer.from(value.ciphertext, 'base64')))
    } catch {
      // Keep the encrypted value intact: unlocking the OS key store may make it readable later.
      this.report('decrypt_failed')
      return emptyValue(key)
    }
  }

  set(values: Record<string, unknown>): void {
    const encoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (PROTECTED_KEYS.has(key)) encoded[key] = this.encode(key, value)
      else encoded[key] = value
    }
    this.backend.set(encoded)
  }

  isPersistedSecret(key: string): boolean {
    return PROTECTED_KEYS.has(key) && !this.sessionValues.has(key) && isEnvelope(this.backend.store[key])
  }

  private available(): boolean {
    // Electron's Linux basic_text backend uses a hardcoded password, not OS protection.
    return this.encryption.isEncryptionAvailable()
      && this.encryption.getSelectedStorageBackend?.() !== 'basic_text'
  }

  private encode(key: string, value: unknown): unknown {
    if (isEmpty(value)) {
      this.sessionValues.delete(key)
      return emptyValue(key)
    }
    try {
      if (!this.available()) throw new Error('key_store_unavailable')
      const ciphertext = this.encryption.encryptString(JSON.stringify(value)).toString('base64')
      this.sessionValues.delete(key)
      return { opentypeEncrypted: 1, ciphertext } satisfies Envelope
    } catch {
      // Still usable in this session, but never fall back to persisting plaintext credentials.
      this.sessionValues.set(key, structuredClone(value))
      this.report('session_only')
      return emptyValue(key)
    }
  }

  private report(issue: SecretStorageIssue): void {
    if (this.reported.has(issue)) return
    this.reported.add(issue)
    this.onIssue(issue)
  }
}
