import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { AudioStorage } from './audio-storage'
import type { AudioStorageAction } from '../../shared/audio-storage'
/** Only the main settings/history renderer can use a review token. */
export function registerAudioStorage(storage: () => AudioStorage, owner: () => WebContents | undefined,
  handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void = (channel,fn) => ipcMain.handle(channel,fn)) {
  const caller = (event: IpcMainInvokeEvent) => {
    const current = owner()
    if (!current || event.sender !== current || event.senderFrame !== current.mainFrame) throw new Error('audio_storage_invalid_selection')
  }
  handle('desktop:audio-storage-scan', event => { caller(event); return storage().scan() })
  handle('desktop:audio-storage-preview', (event, token: string, key: string) => { caller(event); return storage().preview(token,key) })
  handle('desktop:audio-storage-act', (event, token: string, keys: string[], action: AudioStorageAction) => { caller(event); return storage().act(token,keys,action) })
}
