export interface SyncedDictionaryValue { deleted: boolean; term?: string; pronunciation?: string }
export interface SyncedDictionaryWord extends SyncedDictionaryValue { key: string; revision: number }
export interface DictionaryMutation { key: string; mutationId: string; baseRevision: number; value: SyncedDictionaryValue }
export interface DictionaryMutationResult { key: string; mutationId: string; status: 'accepted'|'conflict'; word: SyncedDictionaryWord }
export interface DictionaryConflict { key: string; mutationId: string; local: SyncedDictionaryValue; remote: SyncedDictionaryWord; previous?: SyncedDictionaryValue }
export interface DictionarySyncStatus {
  account: boolean
  accountScope?:string
  scope: string
  view: 'local'|'account'
  enabled: boolean
  joined: boolean
  phase: 'idle'|'syncing'|'error'|'disabled'
  detail?: string
  pending: number
  conflicts: number
  lastSyncedAt?: string
}
