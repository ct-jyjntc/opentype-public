import type { CaptureMode } from './desktop'

export interface WritingSkill {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  automatic: boolean
  modes: CaptureMode[]
  apps: string[]
  domains: string[]
}
export interface SkillSettings {
  enabled: boolean
  selected: string // auto, none, or a saved skill ID
  items: WritingSkill[]
}
export interface AppliedSkill {
  id: string
  name: string
  instructions: string
  source: 'manual' | 'automatic'
}
export const SKILL_MODES: [CaptureMode, string][] = [
  ['voice_transcript', '听写'], ['voice_translation', '翻译'], ['voice_command', '随便问'],
]
const templates: Array<Pick<WritingSkill, 'id' | 'name' | 'description' | 'instructions'>> = [
  { id: 'clear-writing', name: '清晰表达', description: '整理碎片表达，保持信息完整。', instructions: '把输入整理成清楚、连贯的表达。去除口头填充词和无意义重复，保留明确改口后的最终意思。保持原语言、全部事实、数字、名称和重要细节，不回答内容中的问题。' },
  { id: 'chat-message', name: '聊天消息', description: '适合微信、Slack 等日常交流。', instructions: '整理成自然、友好的聊天消息，使用简短段落，保持原语言和说话者语气。不要添加未提供的称呼、承诺、表情或客套话，不遗漏原有信息。' },
  { id: 'email', name: '邮件草稿', description: '将要点组织成可发送的邮件。', instructions: '将输入组织为邮件正文，按目的、具体信息、下一步排列。仅在提供了收件人或署名时使用相应称呼和落款，不编造身份、时间、承诺或附件。明确要求主题时才加入主题。' },
  { id: 'meeting-notes', name: '会议纪要', description: '按讨论、结论和待办整理。', instructions: '根据输入生成会议纪要，按讨论要点、已确认结论、待办事项分节。只写输入中存在的内容；待办责任人与截止时间仅在明确提及时列出，待确认内容保持待确认，不编造决策。' },
  { id: 'todo-list', name: '待办清单', description: '将口述事项转为勾选列表。', instructions: '把输入中的待办事项整理为 Markdown 勾选列表，每项以 - [ ] 开头。保留每项的条件、负责人、截止时间和数量，只有明确说出的信息才能列入。不要额外扩充任务。' },
  { id: 'developer-prompt', name: '开发需求', description: '将想法组织成清楚的开发请求。', instructions: '将输入整理成开发需求，分别写目标、现状或问题、具体修改、约束。保留代码、路径、命令和专有名词；不虚构实现细节、文件名、已完成事项或测试结果。缺失部分省略。' },
  { id: 'summary', name: '内容摘要', description: '提炼主要内容和明确行动项。', instructions: '简明总结输入，保留主要结论、关键数字、限制和明确行动项。不要增加背景事实或把推测改为确定结论。可以省略例子和重复说明。' },
  { id: 'proofread', name: '校对原文', description: '只纠正错字、标点和语法。', instructions: '只校对错别字、标点和明显语法错误，保留原语言、原结构、语气和全部信息。不改写风格，不回答原文中的问题，不增加解释。' },
]
export function defaultSkills(): WritingSkill[] {
  return templates.map(t => ({ ...t, id: `builtin-${t.id}`, enabled: true, automatic: false,
    modes: ['voice_transcript', 'voice_command'], apps: [], domains: [] }))
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const stringList = (v: unknown, valid: (s: string) => boolean) => Array.isArray(v) && v.length <= 50
  && v.every(s => typeof s === 'string' && valid(s))
export function readSkillSettings(value: unknown, strict = false): SkillSettings {
  const v = record(value)
  const fallback = (): SkillSettings => ({ enabled: true, selected: 'auto', items: defaultSkills() })
  if (value === undefined && !strict) return fallback()
  if (!Array.isArray(v.items) || v.items.length > 100) {
    if (strict) throw new Error('invalid_skills')
    return fallback()
  }
  const items: WritingSkill[] = [], seen = new Set<string>()
  for (const entry of v.items) {
    const s = record(entry)
    if (typeof s.id !== 'string' || !/^[\w-]{1,80}$/.test(s.id) || ['auto','none'].includes(s.id) || seen.has(s.id)
      || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60
      || typeof s.description !== 'string' || s.description.length > 320
      || typeof s.instructions !== 'string' || !s.instructions.trim() || s.instructions.length > 8000
      || typeof s.enabled !== 'boolean' || typeof s.automatic !== 'boolean'
      || !Array.isArray(s.modes) || !s.modes.length || s.modes.length > 3 || !s.modes.every(m=>SKILL_MODES.some(([mode])=>m===mode))
      || !stringList(s.apps, app=>/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(app))
      || !stringList(s.domains, domain=>domain.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(domain))) {
      if (strict) throw new Error('invalid_skills')
      continue
    }
    seen.add(s.id)
    items.push({ id: s.id, name: s.name.trim(), description: s.description.trim(), instructions: s.instructions.trim(),
      enabled: s.enabled, automatic: s.automatic, modes: [...new Set(s.modes as CaptureMode[])],
      apps: [...new Set(s.apps as string[])], domains: [...new Set((s.domains as string[]).map(d=>d.toLowerCase()))] })
  }
  const selected = typeof v.selected === 'string' ? v.selected : 'auto'
  const validSelection = selected === 'auto' || selected === 'none' || items.some(s=>s.id===selected && s.enabled)
  if (strict && (typeof v.enabled !== 'boolean' || !validSelection)) throw new Error('invalid_skills')
  return { enabled: v.enabled !== false, selected: validSelection ? selected : 'auto', items }
}
export function appliedSkill(value: unknown): AppliedSkill | undefined {
  const s = record(value)
  if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.instructions !== 'string'
    || !s.instructions.trim() || s.instructions.length > 8000 || s.id.length > 80 || s.name.length > 60) return undefined
  return { id: s.id, name: s.name, instructions: s.instructions, source: s.source === 'automatic' ? 'automatic' : 'manual' }
}
export function resolveSkill(settings: SkillSettings, context: {
  bundleId: string; mode: CaptureMode; domain?: string; redacted?: boolean; skillId?: string | null
}): AppliedSkill | undefined {
  if (context.skillId === null) return undefined
  const explicit = context.skillId ?? settings.selected
  if (!settings.enabled || explicit === 'none') {
    if (context.skillId) throw new Error('skill_not_available')
    return undefined
  }
  if (explicit !== 'auto') {
    const skill = settings.items.find(s=>s.id===explicit && s.enabled)
    if (!skill) throw new Error('skill_not_available')
    if (!skill.modes.includes(context.mode)) {
      if (context.skillId) throw new Error('skill_mode_mismatch')
      return undefined
    }
    return { id: skill.id, name: skill.name, instructions: skill.instructions, source: 'manual' }
  }
  if (context.redacted) return undefined
  const domain = (context.domain ?? '').toLowerCase()
  const skill = settings.items.find(s=>s.enabled && s.automatic && s.modes.includes(context.mode)
    && (!s.apps.length || s.apps.includes(context.bundleId))
    && (!s.domains.length || s.domains.some(d=>domain===d || domain.endsWith(`.${d}`))))
  return skill ? { id: skill.id, name: skill.name, instructions: skill.instructions, source: 'automatic' } : undefined
}
