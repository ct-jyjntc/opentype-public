import { randomUUID } from 'node:crypto'
import type { CardPayload } from '../../shared/desktop'
import { resolveSkill, type SkillSettings } from '../../shared/skills'
import type { CaptureTarget } from './capture-session'
import type { AnswerSelection } from './answer-card'
import { refineTranscript, type RefinementConfig } from './providers/refinement'

export type SelectionAction = 'summarize' | 'rewrite' | 'translate' | 'proofread' | 'skill' | 'custom'
interface PendingSelection {
  id: string
  target: CaptureTarget
  controller?: AbortController
  timer: ReturnType<typeof setTimeout>
  payload: CardPayload
}
export class SelectionActions {
  private current?: PendingSelection
  get isBusy() { return !!this.current?.controller }
  constructor(private deps: {
    settings: () => SkillSettings
    refinement: () => RefinementConfig
    outputLanguage: () => string
    show: (payload: CardPayload) => void
    complete: (payload: CardPayload, selection?: AnswerSelection) => void
    release: (token: string) => void
    busy: () => boolean
  }) {}
  present(target: CaptureTarget) {
    this.close()
    if (target.audioContext.redacted || !target.selectedText.trim() || target.selectedText.length > 1_000_000) {
      if (target.inputToken) this.deps.release(target.inputToken)
      this.deps.show({ text: target.audioContext.redacted ? '此输入环境受隐私保护，未读取选中文字。' : '请先在目标应用中选中文字，再打开快捷操作。', title: '选中文字快捷操作', id: randomUUID() })
      return
    }
    const id = randomUUID(), settings = this.deps.settings()
    const payload: CardPayload = { id, title: '选中文字快捷操作', text: '', targetAppName: target.appName,
      selectionActions: { source: target.selectedText, busy: false, skills: settings.enabled ? settings.items.filter(s=>s.enabled).map(s=>({id:s.id,name:s.name})) : [] } }
    const timer = setTimeout(() => {
      if (this.current?.id !== id) return
      this.close(); this.deps.show({ id: randomUUID(), title: '选区已过期', text: '请重新选中文字并打开快捷操作。' })
    }, 10 * 60_000)
    timer.unref()
    this.current = { id, target, timer, payload }; this.deps.show(payload)
  }
  cancel(id: string) {
    const current = this.current
    if (!current || current.id !== id) return
    current.controller?.abort(); current.controller = undefined
    current.payload = { ...current.payload, detail: 'cancelled', selectionActions: { ...current.payload.selectionActions!, busy: false, preview: undefined } }
    this.deps.show(current.payload)
  }
  async run(id: string, action: SelectionAction, options?: { skillId?: string; instruction?: string }) {
    const current = this.current
    if (!current || current.id !== id) throw new Error('answer_selection_expired')
    if (current.controller || this.deps.busy()) throw new Error('answer_recording_busy')
    if (!['summarize','rewrite','translate','proofread','skill','custom'].includes(action)) throw new Error('invalid_config')
    const source = current.target.selectedText
    const instructions = { summarize: '准确概括选中文字，保留关键事实、结论、数字与待办事项。', rewrite: '将选中文字改写得清楚自然，保留全部信息、事实和语气。', proofread: '校对选中文字，只纠正错别字、语法和标点，保持原意与语气。' }
    let mode: 'voice_command' | 'voice_translation' | 'voice_transcript' = action === 'translate' ? 'voice_translation' : 'voice_command'
    let transcript = action === 'translate' ? source : instructions[action as keyof typeof instructions] ?? ''
    let skill
    if (action === 'custom') {
      if (typeof options?.instruction !== 'string' || !options.instruction.trim() || options.instruction.length > 8000) throw new Error('skill_input_required')
      transcript = options.instruction.trim()
    }
    if (action === 'skill') {
      const settings = this.deps.settings(), saved = settings.items.find(s => s.id === options?.skillId)
      if (!saved) throw new Error('skill_not_available')
      mode = saved.modes[0]
      skill = resolveSkill(settings, { bundleId: current.target.bundleId, mode, skillId: saved.id })
      if (!skill) throw new Error('skill_not_available')
      transcript = mode === 'voice_command' ? '请按照所选 Skill 处理 selected_text 中的文字。' : source
    }
    const controller = new AbortController(); current.controller = controller
    const update = (preview?: string, detail?: string) => {
      if (this.current !== current || controller.signal.aborted || current.controller !== controller) return
      current.payload = { ...current.payload, detail, selectionActions: { ...current.payload.selectionActions!, busy: true, preview } }
      this.deps.show(current.payload)
    }
    update()
    try {
      const result = await refineTranscript(transcript, { mode, audio: new Uint8Array(), audioId: id, duration: 0, audioMetadata: {},
        audioContext: current.target.audioContext, parameters: { selected_text: source, skill, output_language: this.deps.outputLanguage() },
        signal: controller.signal, onProgress: p => update(p.preview) }, this.deps.refinement())
      controller.signal.throwIfAborted()
      if (this.current !== current || current.controller !== controller) return
      if (!result.success || !result.text || result.detail) throw new Error(result.detail || 'refine_failed')
      this.current = undefined; clearTimeout(current.timer)
      const selection = current.target.inputToken ? { token: current.target.inputToken, selectedText: source, appName: current.target.appName } : undefined
      try {
        this.deps.complete({ title: skill?.name || ({ summarize:'选区摘要',rewrite:'选区改写',translate:'选区翻译',proofread:'选区校对',custom:'选区处理' } as Record<string,string>)[action],
          text: result.text, origin: 'selection', contextNotice: '结果尚未替换原文。您可以复制，或替换最初选中的文字。' }, selection)
      } catch (error) { if (selection) this.deps.release(selection.token); throw error }
    } catch (error) {
      if (this.current === current && current.controller === controller && !controller.signal.aborted) {
        current.payload = { ...current.payload, detail: (error as Error).message, selectionActions: { ...current.payload.selectionActions!, busy: false, preview: undefined } }
        this.deps.show(current.payload)
      }
    } finally { if (current.controller === controller) current.controller = undefined }
  }
  close() {
    const current = this.current; this.current = undefined
    if (!current) return
    clearTimeout(current.timer); current.controller?.abort()
    if (current.target.inputToken) this.deps.release(current.target.inputToken)
  }
}
