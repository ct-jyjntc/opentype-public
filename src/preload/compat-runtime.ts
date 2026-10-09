import { contextBridge, ipcRenderer } from 'electron'

// Loaded before the legacy UI's modules. Only public routing configuration crosses this
// bridge; account tokens and API keys stay on their existing explicit IPC paths.
const runtime = ipcRenderer.sendSync('config:frontend-runtime')
if (!runtime || typeof runtime.cloudBaseUrl !== 'string' || typeof runtime.appVersion !== 'string') {
  throw new Error('OpenType runtime configuration unavailable')
}
contextBridge.exposeInMainWorld('opentypeRuntime', {
  cloudBaseUrl: runtime.cloudBaseUrl,
  appVersion: runtime.appVersion,
  provider: runtime.provider,
  voiceTransport: 'ipc'
})
