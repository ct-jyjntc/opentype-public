export interface BackupPreview {
  dictionaryTarget:'local'|'account'
  token: string
  fileName: string
  createdAt: string
  settings: number
  skills: number
  words: number
  newWords: number
  conflicts: number
}
export interface BackupRestoreResult { added: number; updated: number; kept: number; settingsRestored: boolean }
