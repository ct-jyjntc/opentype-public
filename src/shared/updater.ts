export interface UpdateState {
  phase: 'idle'|'checking'|'current'|'available'|'downloading'|'ready'|'installing'|'cancelled'|'error'|'unavailable'
  channel: 'stable'|'beta'
  version?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  message?: string
}
