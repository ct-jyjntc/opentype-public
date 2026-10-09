import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { resolveSkill, type SkillSettings } from '../../shared/skills'
import { refineTranscript, type RefinementConfig } from './providers/refinement'

/** Explicit text processing uses saved instructions and the same text-only service as speech. */
export function registerSkillActions(deps: {
  owner: () => WebContents | undefined
  settings: () => SkillSettings
  refinement: () => RefinementConfig
  outputLanguage: () => string
}) {
  const requests = new Map<string, { owner: WebContents; controller: AbortController }>()
  const authorize = (event: IpcMainInvokeEvent) => {
    const owner = deps.owner()
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('invalid_skill_request')
    return owner
  }
  ipcMain.handle('desktop:skill-run', async (event, id: string, skillId: string, text: string) => {
    const owner = authorize(event)
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || typeof skillId !== 'string') throw new Error('invalid_skill_request')
    if (typeof text !== 'string' || !text.trim()) throw new Error('skill_input_required')
    if (text.length > 1_000_000) throw new Error('invalid_history_text')
    for (const [key, request] of requests) if (request.owner === owner) { request.controller.abort(); requests.delete(key) }
    const settings = deps.settings(), saved = settings.items.find(s=>s.id===skillId)
    if (!saved) throw new Error('skill_not_available')
    const mode = saved.modes[0]
    const skill = resolveSkill(settings, { bundleId: '', mode, skillId })
    if (!skill) throw new Error('skill_not_available')
    const controller = new AbortController(), request = { owner, controller }
    requests.set(id, request)
    const closed = () => controller.abort()
    owner.once('destroyed', closed)
    try {
      const result = await refineTranscript(text, { mode, audio: new Uint8Array(), audioId: id, duration: 0,
        audioMetadata: {}, audioContext: { redacted: true },
        parameters: { skill, output_language: deps.outputLanguage() }, signal: controller.signal,
        onProgress: progress => {
          if (!controller.signal.aborted && !owner.isDestroyed() && requests.get(id) === request)
            owner.send('desktop:skill-progress', { id, ...progress })
        } }, deps.refinement())
      if (controller.signal.aborted) throw new Error('cancelled')
      if (!result.success || !result.text) throw new Error(result.detail ?? 'skill_failed')
      return { text: result.text, skillName: skill.name }
    } finally {
      if (requests.get(id) === request) requests.delete(id)
      owner.removeListener('destroyed', closed)
    }
  })
  ipcMain.handle('desktop:skill-cancel', (event, id: string) => {
    const owner = authorize(event), request = requests.get(id)
    if (request?.owner === owner) request.controller.abort()
  })
  return { isBusy: () => requests.size > 0, dispose: () => { for (const request of requests.values()) request.controller.abort(); requests.clear() } }
}
