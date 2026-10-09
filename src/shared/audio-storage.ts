export interface StoredAudio {
  key: string
  name: string
  bytes: number
  modifiedAt: number
}
export interface AudioStorageSnapshot {
  token: string
  candidates: StoredAudio[]
  recycled: StoredAudio[]
  protectedFiles: number
  recentFiles: number
  unknownFiles: number
  unresolvedItems: number
  truncated: boolean
}
export type AudioStorageAction = 'recycle' | 'restore' | 'recover' | 'erase'
export interface AudioStorageResult {
  completed: number
  bytes: number
  failed: Array<{ name: string; detail: string }>
}
