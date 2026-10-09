export interface OutputAudioStatus {
  supported: boolean
  recording: boolean
  phase: 'idle' | 'starting' | 'active' | 'restoring' | 'pending' | 'error'
  mode: 'off' | 'duck' | 'mute'
  detail?: string
}
