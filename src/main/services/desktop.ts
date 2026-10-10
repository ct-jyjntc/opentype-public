/** Source renderer services. Persistence and voice work stay in the main process. */
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { CorrectionRepo, DictionaryRepo, HistoryRepo, type HistoryRow, type HistorySyncAccount } from '../db'
import { parseShortcutString } from './hotkey'
import { validateShortcut } from './shortcut-validation'
import { parseLocalDictionaryRows } from './dictionary-csv'
import type { Preferences, HistoryItem } from '../../shared/desktop'
import { readFloatingBar } from '../../shared/floating-bar'
import { dictionaryTermKey } from '../db/dictionary-sync'
import { readSkillSettings } from '../../shared/skills'
import { parseMeta } from '../../shared/desktop'
import { COMMON_WRITING_APPS, readAppExpressions, readOutputPreferences } from '../../shared/output-preferences'
import type { DictionaryCsvParseResult } from './dictionary-csv'
interface DesktopDeps {
  getBlacklistDomains?: () => string[]
  cloudAccount?: () => HistorySyncAccount | null
  isRecordingBusy?: () => boolean
  getPreferences: () => Record<string, unknown>
  savePreferences: (value: Preferences) => void
  reloadShortcuts: () => void
  completeOnboarding: () => void
  audio: (id: string) => Promise<Buffer | null>
  voice: (params: Record<string, unknown>) => Promise<unknown>
  importCsv: () => Promise<DictionaryCsvParseResult>
  changed: () => void
}
export function readPreferences(value: Record<string, unknown>): Preferences {
  const audio = value.audioProcessing && typeof value.audioProcessing === 'object' ? value.audioProcessing as Record<string, unknown> : {}
  return {
    floatingBar: readFloatingBar(value.floatingBar),
    outputAudio: value.outputAudio === 'duck' || value.outputAudio === 'mute' ? value.outputAudio : 'off',
    interactionSounds: value.interactionSounds === true,
    audioProcessing: { echoCancellation: audio.echoCancellation !== false, noiseSuppression: audio.noiseSuppression !== false, autoGainControl: audio.autoGainControl !== false },
    recordingActivation: value.recordingActivation === 'hold' || value.recordingActivation === 'toggle'
      ? value.recordingActivation : 'auto',
    selectedLanguages: Array.isArray(value.selectedLanguages)
      ? (value.selectedLanguages as string[])
      : [],
    featureShortcutBindings: (value.featureShortcutBindings ?? {}) as Record<
      string,
      string[]
    >,
    appearance: ['light', 'dark'].includes(String(value.appearance))
      ? (value.appearance as 'light' | 'dark')
      : 'system',
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    showInDock: value.showInDock !== false,
    personalStyle:
      typeof value.personalStyle === 'string' ? value.personalStyle : '',
    usePersonalStyle: value.usePersonalStyle === true,
    learnFromEdits: value.learnFromEdits !== false,
    learnFromInputEdits: value.learnFromInputEdits === true,
    outputPreferences: readOutputPreferences(value.outputPreferences),
    appExpressions: readAppExpressions(value.appExpressions),
    skills: readSkillSettings(value.skills),
  }
}
function item(row: HistoryRow): HistoryItem {
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    refinedText: row.refinedText,
    editedText: row.editedText,
    duration: row.duration,
    focusedAppName: row.focusedAppName,
    createdAt: row.createdAt,
    modeMeta: JSON.stringify(parseMeta(row.modeMeta)),
    debugInfo: row.debugInfo,
  }
}
export function registerDesktop(
  deps: DesktopDeps,
  handle: (ch: string, fn: (...args: any[]) => unknown) => void = (ch, fn) =>
    ipcMain.handle(ch, (_, ...args) => fn(...args)),
) {
  handle('desktop:snapshot', () => ({
    version: app.getVersion(),
    platform: process.platform,
    preferences: readPreferences(deps.getPreferences()),
  }))
  const updatePreferences = (patch: Partial<Preferences>, preview = false) => {
    const old = readPreferences(deps.getPreferences()),
      next = { ...old }
    if (patch.floatingBar !== undefined) next.floatingBar = readFloatingBar(patch.floatingBar, true)
    if (patch.outputAudio !== undefined) {
      if (!['off', 'duck', 'mute'].includes(patch.outputAudio)) throw new Error('invalid_config')
      next.outputAudio = patch.outputAudio
    }
    if (typeof patch.interactionSounds === 'boolean') next.interactionSounds = patch.interactionSounds
    if (patch.audioProcessing !== undefined) {
      if (!patch.audioProcessing || ['echoCancellation','noiseSuppression','autoGainControl'].some(key=>typeof (patch.audioProcessing as unknown as Record<string, unknown>)[key] !== 'boolean')) throw new Error('invalid_config')
      next.audioProcessing = { echoCancellation: patch.audioProcessing.echoCancellation, noiseSuppression: patch.audioProcessing.noiseSuppression, autoGainControl: patch.audioProcessing.autoGainControl }
    }
    if (patch.skills !== undefined) next.skills = readSkillSettings(patch.skills, true)
    if (patch.outputPreferences !== undefined) next.outputPreferences = readOutputPreferences(patch.outputPreferences, true)
    if (patch.appExpressions !== undefined) next.appExpressions = readAppExpressions(patch.appExpressions, true)
    if ((patch.featureShortcutBindings || patch.recordingActivation !== undefined) && deps.isRecordingBusy?.())
      throw new Error('请先结束当前听写，再修改快捷键')
    if (patch.recordingActivation !== undefined) {
      if (!['auto', 'hold', 'toggle'].includes(patch.recordingActivation)) throw new Error('invalid_config')
      next.recordingActivation = patch.recordingActivation
    }
    if (patch.featureShortcutBindings) {
      const seen = new Set<string>()
      for (const key of ['dictationMode', 'translationMode', 'askAnythingMode', 'pasteLastTranscript', 'selectionActions']) {
        const optional = ['pasteLastTranscript','selectionActions'].includes(key)
        const list = patch.featureShortcutBindings[key] ?? (optional ? [] : undefined)
        if (!Array.isArray(list) || list.length > 3 || (!optional && !list.length)) throw new Error('invalid_shortcut')
        // Bindings already saved for this feature pass through unchanged (e.g. a legacy Shift+letter),
        // so tightened rules only reject new or changed shortcuts instead of blocking every save.
        const savedList: unknown = old.featureShortcutBindings[key]
        const saved = Array.isArray(savedList) ? savedList : []
        for (const shortcut of list) {
          const b = typeof shortcut === 'string' ? parseShortcutString(shortcut) : null
          const unchanged = !!b && typeof shortcut === 'string' && saved.includes(shortcut)
          if (!b || (!unchanged && (!validateShortcut(b).valid
            || !/^(Fn|F[1-9]|F1[0-2]|[A-Z0-9]|Space|Shift|Command|Control|Option)$/.test(b.key)
            || (!b.modifiers.length && !/^(Fn|F\d{1,2})$/.test(b.key) && b.keyCode === undefined)))) throw new Error('invalid_shortcut')
          const modifierOnly = ['Fn','Shift','Command','Control','Option'].includes(b.key)
          const signature = modifierOnly ? [b.keyCode ?? '', ...[b.key, ...b.modifiers].sort()].join('+')
            : [b.key, ...[...b.modifiers].sort()].join('+')
          if (seen.has(signature)) throw new Error('invalid_shortcut')
          seen.add(signature)
        }
      }
      next.featureShortcutBindings = patch.featureShortcutBindings
    }
    if (patch.selectedLanguages)
      next.selectedLanguages = patch.selectedLanguages
        .filter((x) => typeof x === 'string' && x.length < 30)
        .slice(0, 20)
    if (
      patch.appearance &&
      ['system', 'light', 'dark'].includes(patch.appearance)
    ) {
      next.appearance = patch.appearance
      if (!preview) nativeTheme.themeSource = patch.appearance
    }
    if (typeof patch.personalStyle === 'string')
      next.personalStyle = patch.personalStyle.slice(0, 1200)
    if (typeof patch.usePersonalStyle === 'boolean')
      next.usePersonalStyle = patch.usePersonalStyle
    if (typeof patch.learnFromEdits === 'boolean') next.learnFromEdits = patch.learnFromEdits
    if (typeof patch.learnFromInputEdits === 'boolean') next.learnFromInputEdits = patch.learnFromInputEdits
    if (typeof patch.launchAtLogin === 'boolean') {
      if (!preview) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin })
      next.launchAtLogin = preview ? patch.launchAtLogin : app.getLoginItemSettings().openAtLogin
    }
    if (typeof patch.showInDock === 'boolean') {
      next.showInDock = patch.showInDock
      if (app.dock && !preview) {
        if (patch.showInDock) void app.dock.show()
        else app.dock.hide()
      }
    }
    if (preview) return next
    deps.savePreferences(next)
    if (patch.featureShortcutBindings || patch.recordingActivation !== undefined) deps.reloadShortcuts()
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('desktop:preferences-changed', next)
    return next
  }
  handle('desktop:preferences', patch => updatePreferences(patch))
  handle('desktop:complete-onboarding', () => deps.completeOnboarding())
  handle('desktop:writing-apps', async () => {
    const apps = new Map(COMMON_WRITING_APPS.map(a => [a.bundleId, a]))
    const saved = readPreferences(deps.getPreferences()).appExpressions
    const recent = await HistoryRepo.search('', '', 0, 500)
    for (const a of [...recent.map(r => ({ bundleId: r.focusedAppBundleId ?? '', appName: r.focusedAppName ?? '' })), ...saved]) {
      if (a.bundleId && a.appName && !apps.has(a.bundleId)) apps.set(a.bundleId, { bundleId: a.bundleId, appName: a.appName })
    }
    return [...apps.values()]
  })
  handle('desktop:open-url', (url: string) => {
    const parsed = new URL(url)
    if (
      !['https:', 'http:'].includes(parsed.protocol) &&
      !(process.platform === 'win32' && url === 'ms-settings:privacy-microphone') && !url.startsWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_',
      )
    )
      throw new Error('unsupported_url')
    return shell.openExternal(url)
  })
  handle(
    'desktop:history-list',
    async ({ offset = 0, limit = 50, query = '', mode = '' } = {}) => {
      const size = Math.min(100, Math.max(1, Number(limit) || 50))
      const rows = await HistoryRepo.search(
        String(query).slice(0, 500),
        String(mode),
        Math.max(0, Number(offset) || 0),
        size + 1,
      )
      return {
        data: rows.slice(0, size).map(item),
        hasMore: rows.length > size,
      }
    },
  )
  handle('desktop:history-stats', () => HistoryRepo.stats())
  handle('desktop:history-detail', async (id: string) => {
    const row = await HistoryRepo.byId(id)
    if (!row) throw new Error('record_not_found')
    const account = deps.cloudAccount?.()
    return { record: item(row), audio: (await deps.audio(id)) ?? undefined,
      canDeleteCloud: Boolean(account && row.userId === account.userId && row.cloudScope === account.serverUrl) }
  })
  handle('desktop:history-restore-version', (id: string, version: 'raw' | 'processed') => {
    if (typeof id !== 'string' || !['raw','processed'].includes(version)) throw new Error('invalid_history_text')
    const row = CorrectionRepo.restoreVersion(id, version)
    deps.changed()
    return item(row)
  })
  handle('desktop:history-edit', async (id: string, text: string) => {
    const result = CorrectionRepo.saveEdit(id, text, readPreferences(deps.getPreferences()).learnFromEdits, deps.getBlacklistDomains?.())
    deps.changed()
    return result
  })
  const retrying = new Set<string>()
  handle('desktop:history-retry', async (id: string) => {
    if (retrying.has(id)) throw new Error('already_retrying')
    retrying.add(id)
    try {
      const row = await HistoryRepo.byId(id),
        audio = await deps.audio(id)
      if (!row || !audio) throw new Error('audio_missing')
      const result = (await deps.voice({
        audioId: id,
        arrayBuffer: audio.buffer.slice(
          audio.byteOffset,
          audio.byteOffset + audio.byteLength,
        ),
        isRetry: true,
      })) as {
        success: boolean
        refine_text?: string
        raw_text?: string
        detail?: string
      }
      if (await HistoryRepo.isDeleted(id)) throw new Error('record_deleted')
      // A retry failure must not destroy an existing good transcript.
      const metadata = {
        ...parseMeta(row.modeMeta),
        ...(result.raw_text ? { raw_text: result.raw_text } : {}),
      }
      await HistoryRepo.upsert({
        id,
        ...(result.success
          ? {
              status: 'completed',
              refinedText: result.refine_text,
              editedText: null,
              syncStatus: 'pending_upload',
            }
          : {}),
        modeMeta: JSON.stringify(metadata),
        debugInfo: JSON.stringify({ detail: result.detail }),
        updatedAt: new Date().toISOString(),
      })
      deps.changed()
      if (!result.success)
        throw new Error(result.detail ?? 'transcription_failed')
      const current = await HistoryRepo.byId(id)
      if (!current) throw new Error('record_deleted')
      return item(current)
    } finally {
      retrying.delete(id)
    }
  })
  const dictionaryScope=(expected?:string)=>{const scope=DictionaryRepo.scope();if(expected!==undefined&&expected!==scope)throw new Error('dictionary_scope_changed');return scope}
  handle('desktop:dictionary-list', () => DictionaryRepo.list(dictionaryScope()))
  handle('desktop:dictionary-snapshot', async()=>{
    const scope=dictionaryScope(),words=await DictionaryRepo.list(scope);dictionaryScope(scope)
    return {scope,words}
  })
  handle('desktop:corrections-list', (offset?: number, historyId?: string) => CorrectionRepo.list(offset, historyId))
  handle('desktop:corrections-dismiss', (id: string) => CorrectionRepo.dismiss(id))
  handle('desktop:corrections-accept', (id: string, term: string, hint: string, scope?:string) => {
    dictionaryScope(scope)
    return CorrectionRepo.accept(id, term, hint, deps.getBlacklistDomains?.())
  })
  handle(
    'desktop:dictionary-save',
    async ({
      term,
      pronunciation,
      id,
      scope:expectedScope,
      expected,
    }: {
      term: string
      pronunciation: string
      id?: string
      scope?:string
      expected?:{term:string;pronunciation:string|null}
    }) => {
      const scope=dictionaryScope(expectedScope)
      const t = String(term).normalize('NFC').trim()
      if (!t || t.length > 100) throw new Error('empty_term')
      const rows = await DictionaryRepo.list(scope)
      dictionaryScope(scope)
      const found=id?rows.find(w=>w.id===id):undefined
      if(id&&(!found||(expected&&(expected.term!==found.term||(expected.pronunciation??'')!==(found.pronunciation??'')))))throw new Error('dictionary_word_changed')
      if (
        rows.some(
          (w) =>
            dictionaryTermKey(w.term) === dictionaryTermKey(t) && w.id !== id,
        )
      )
        throw new Error('duplicate_term')
      if (id)
        await DictionaryRepo.update(
          scope,
          id,
          t,
          String(pronunciation).trim().slice(0, 100),
        )
      else
        await DictionaryRepo.add(
          scope,
          t,
          String(pronunciation).trim().slice(0, 100),
        )
    },
  )
  handle('desktop:dictionary-remove', async (id: string, expectedScope?:string,expected?:{term:string;pronunciation:string|null}) => {
    const scope=dictionaryScope(expectedScope),found=(await DictionaryRepo.list(scope)).find(w=>w.id===id);dictionaryScope(scope)
    if(expected&&(!found||found.term!==expected.term||(found.pronunciation??'')!==(expected.pronunciation??'')))throw new Error('dictionary_word_changed')
    return DictionaryRepo.remove(scope,id)
  })
  handle('desktop:dictionary-import', async (expectedScope?:string) => {
    const scope=dictionaryScope(expectedScope)
    const parsed = await deps.importCsv()
    if (!parsed.success) return parsed
    dictionaryScope(scope)
    const words = parseLocalDictionaryRows(parsed.words.join('\n'))
    const unique = [...new Map(words.map(w=>[dictionaryTermKey(w.term),w])).values()]
    const result=DictionaryRepo.importPortable(unique.map(w=>({term:w.term,pronunciation:w.hint})),'keep',()=>{})
    return {
      success: true,
      added: result.added,
    }
  })
  return { updatePreferences }
}
