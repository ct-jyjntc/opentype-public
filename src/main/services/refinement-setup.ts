import { readFile, unlink } from 'node:fs/promises'
import type { SecretEncryption } from './secure-store'

export const REFINEMENT_SETUP_FILE = 'opentype-refinement-setup.json'

/** A one-shot encrypted setup file avoids overwriting a running app's config. */
export async function applyPendingRefinement(path: string, encryption: SecretEncryption,
  store: { set(values: Record<string, unknown>): void; isPersistedSecret(key: string): boolean }): Promise<boolean> {
  let source: string
  try { source = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  const envelope = JSON.parse(source)
  if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string'
    || !encryption.isEncryptionAvailable()) throw new Error('invalid_refinement_setup')
  const settings = JSON.parse(encryption.decryptString(Buffer.from(envelope.ciphertext, 'base64')))
  if (settings.refineBaseUrl !== 'https://api.deepseek.com' || settings.refineModel !== 'deepseek-flash'
    || typeof settings.refineApiKey !== 'string' || !settings.refineApiKey.trim()) throw new Error('invalid_refinement_setup')
  store.set({ refineBaseUrl: settings.refineBaseUrl, refineModel: settings.refineModel,
    refineApiKey: settings.refineApiKey, enableRefine: true })
  if (!store.isPersistedSecret('refineApiKey')) throw new Error('refinement_key_not_persisted')
  await unlink(path)
  return true
}
