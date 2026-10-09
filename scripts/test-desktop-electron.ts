import { app } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, closeDatabase, HistoryRepo } from '../src/main/db'
import { registerDesktop } from '../src/main/services/desktop'
import { parseMeta } from '../src/shared/desktop'
import { AudioStorage } from '../src/main/services/audio-storage'
import { registerAudioStorage } from '../src/main/services/audio-storage-ipc'
const dir = mkdtempSync(join(tmpdir(), 'opentype-desktop-api-'))
app.setPath('userData', dir)
app.whenReady().then(async () => {
  let code = 0
  try {
    initDatabase(join(dir, 'db'))
    const handlers = new Map<string, (...args: any[]) => any>()
    let preferences: Record<string, unknown> = {
      featureShortcutBindings: {
        dictationMode: ['Fn'],
        translationMode: ['Fn+Shift'],
        askAnythingMode: ['Fn+Space'],
      },
    }
    let success = true,
      changes = 0
    let pendingVoice: Promise<unknown> | undefined
    let voiceEntered: (() => void) | undefined
    let captureBusy = false, shortcutReloads = 0
    let cloudAccount: { userId: string; serverUrl: string } | null = { userId: 'test-owner', serverUrl: 'https://synthetic.invalid' }
    registerDesktop(
      {
        cloudAccount: () => cloudAccount,
        isRecordingBusy: () => captureBusy,
        getPreferences: () => preferences,
        savePreferences: (v) =>
          (preferences = v as unknown as Record<string, unknown>),
        reloadShortcuts: () => { shortcutReloads++ },
        completeOnboarding: () => {},
        audio: async () => Buffer.from('RIFFtest'),
        voice: async () => {
          voiceEntered?.()
          return pendingVoice ?? ({
          success,
          refine_text: success ? 'retried' : '',
          raw_text: 'original',
          detail: success ? '' : 'refine_failed',
          })
        },
        importCsv: async () => ({
          success: true,
          fileName: 'test.csv',
          words: [
            'term,hint',
            'OpenType,open type',
            '"Acme, Inc.",acme',
            'OpenType,duplicate',
          ],
        }),
        changed: () => changes++,
      },
      (ch, fn) => handlers.set(ch, fn),
    )
    const call = (name: string, ...args: any[]) =>
      handlers.get('desktop:' + name)!(...args)
    await HistoryRepo.upsert({ id: 'cloud-owned', userId: cloudAccount.userId, cloudScope: cloudAccount.serverUrl, status: 'completed', refinedText: 'synthetic' })
    assert.equal((await call('history-detail', 'cloud-owned')).canDeleteCloud, true)
    cloudAccount = { ...cloudAccount, serverUrl: 'https://other.invalid' }
    assert.equal((await call('history-detail', 'cloud-owned')).canDeleteCloud, false)
    cloudAccount = null
    assert.equal((await call('history-detail', 'cloud-owned')).canDeleteCloud, false)
    await HistoryRepo.remove('cloud-owned')
    await call('dictionary-save', {
      term: 'TypeScript',
      pronunciation: 'type script',
    })
    assert.equal((await call('dictionary-list')).length, 1)
    await assert.rejects(
      async () =>
        call('dictionary-save', { term: 'typescript', pronunciation: '' }),
      /duplicate_term/,
    )
    assert.equal((await call('dictionary-import')).added, 2)
    const words = await call('dictionary-list')
    assert.equal(
      words.find((w: any) => w.term === 'OpenType').pronunciation,
      'open type',
    )
    assert(words.some((w: any) => w.term === 'Acme, Inc.'))
    await call('dictionary-save', {
      id: words[0].id,
      term: 'Edited',
      pronunciation: 'hint',
    })
    assert(
      (await call('dictionary-list')).some((w: any) => w.term === 'Edited'),
    )
    await call('dictionary-remove', words[0].id)
    assert.equal((await call('dictionary-list')).length, 2)
    console.log(
      'OK local dictionary CRUD, case-insensitive duplicate detection, CSV quotes/header/hints',
    )
    await call('preferences', {
      selectedLanguages: ['zh-CN'],
      personalStyle: 'concise',
      usePersonalStyle: true,
    })
    assert.equal(preferences.personalStyle, 'concise')
    assert.deepEqual((await call('snapshot')).preferences.outputPreferences, { punctuation: 'preserve', spacing: 'preserve', expression: 'original' })
    const outputPreferences = { punctuation: 'chinese', spacing: 'space', expression: 'concise' }
    const appExpressions = [{ bundleId: 'test.editor', appName: 'Editor', expression: 'formal' }]
    await call('preferences', { outputPreferences, appExpressions })
    assert.deepEqual((await call('snapshot')).preferences.outputPreferences, outputPreferences)
    assert.deepEqual((await call('snapshot')).preferences.appExpressions, appExpressions)
    assert((await call('writing-apps')).some((a: any) => a.bundleId === 'test.editor'))
    const savedPreferences = JSON.stringify(preferences)
    for (const patch of [{ outputPreferences: { ...outputPreferences, spacing: 'wrong' } }, { appExpressions: [...appExpressions, ...appExpressions] }, { appExpressions: null }]) {
      await assert.rejects(async () => call('preferences', patch), /invalid_(output_preferences|app_expression)/)
      assert.equal(JSON.stringify(preferences), savedPreferences)
    }
    await call('preferences', { appExpressions: [] })
    assert.deepEqual((await call('snapshot')).preferences.appExpressions, [])
    console.log('OK structured output settings and app rules persist; invalid writes are atomic and deletion restores defaults')

    for (const shortcut of ['Cmd+Q', 'Fn', 'Cmd+Banana', 'F99'])
      await assert.rejects(
        async () =>
          call('preferences', {
            featureShortcutBindings: {
              dictationMode: [shortcut],
              translationMode: ['Fn+Shift'],
              askAnythingMode: ['Fn'],
            },
          }),
        /invalid_shortcut/,
      )
    assert.equal(
      (
        await call('preferences', {
          featureShortcutBindings: {
            dictationMode: ['F8'],
            translationMode: ['Fn+Shift'],
            askAnythingMode: ['Fn+Space'],
          },
        })
      ).featureShortcutBindings.dictationMode[0],
      'F8',
    )
    for (const key of ['RightCommand', 'RightControl', 'LeftOption', 'Ctrl+1']) {
      const saved = await call('preferences', {featureShortcutBindings: {
        dictationMode: [key], translationMode: ['Fn+Shift'], askAnythingMode: ['Fn+Space'],
      }})
      assert.equal(saved.featureShortcutBindings.dictationMode[0], key)
    }
    console.log('OK preferences including physical modifiers, digits, invalid/reserved/duplicate validation')
    assert.equal((await call('snapshot')).preferences.recordingActivation, 'auto')
    for (const recordingActivation of ['hold', 'toggle', 'auto']) {
      const saved = await call('preferences', { recordingActivation })
      assert.equal(saved.recordingActivation, recordingActivation)
      assert.equal((await call('snapshot')).preferences.recordingActivation, recordingActivation)
    }
    await assert.rejects(async () => call('preferences', { recordingActivation: 'unknown' }), /invalid_config/)
    const beforeReloads = shortcutReloads
    captureBusy = true
    await assert.rejects(async () => call('preferences', { recordingActivation: 'hold' }), /请先结束/)
    await assert.rejects(async () => call('preferences', { featureShortcutBindings: {} }), /请先结束/)
    await call('preferences', { personalStyle: 'still editable' })
    assert.equal(shortcutReloads, beforeReloads)
    captureBusy = false
    console.log('OK activation preferences persist in the store and cannot disrupt an active capture')
    await HistoryRepo.upsert({
      id: 'sample',
      status: 'completed',
      mode: 'voice_transcript',
      refinedText: 'initial',
      duration: 1,
      modeMeta: JSON.stringify({ raw_text: 'raw' }),
      createdAt: new Date().toISOString(),
    })
    assert.equal(
      parseMeta((await call('history-detail', 'sample')).record.modeMeta)
        .raw_text,
      'raw',
    )
    assert.equal((await call('history-retry', 'sample')).refinedText, 'retried')
    success = false
    await assert.rejects(
      async () => call('history-retry', 'sample'),
      /refine_failed/,
    )
    assert.equal((await HistoryRepo.byId('sample'))?.refinedText, 'retried')
    await call('history-edit', 'sample', 'my edit')
    assert.equal(
      (await call('history-list', { query: 'my edit' })).data[0].editedText,
      'my edit',
    )
    assert(changes >= 3)
    assert.equal((await call('history-detail', 'sample')).audio.byteLength, 8)
    console.log(
      'OK history metadata/audio, edit/search, retry preserves good text on failure',
    )
    let finishVoice!: (value: unknown) => void
    pendingVoice = new Promise(resolve => { finishVoice = resolve })
    const entered = new Promise<void>(resolve => { voiceEntered = resolve })
    const retry = assert.rejects(call('history-retry', 'sample'), /record_deleted/)
    await entered
    await HistoryRepo.remove('sample')
    finishVoice({ success: true, refine_text: 'late retry' })
    await retry
    assert.equal(await HistoryRepo.byId('sample'), null)
    console.log('OK deleted history cannot be restored by a late desktop retry')
    await HistoryRepo.upsert({ id: 'learning-api', status: 'completed', mode: 'voice_transcript', refinedText: 'Use Opentipe today.', focusedAppName: 'Test editor', focusedAppBundleId: 'test.editor' })
    assert.equal((await call('snapshot')).preferences.learnFromEdits, true)
    assert.equal((await call('snapshot')).preferences.learnFromInputEdits, false)
    await call('preferences', { learnFromInputEdits: true })
    assert.equal((await call('snapshot')).preferences.learnFromInputEdits, true)
    await call('preferences', { learnFromInputEdits: false })
    await call('preferences', { learnFromEdits: false })
    assert.equal((await call('history-edit', 'learning-api', 'Use OpenType today.')).candidates, 0)
    await call('preferences', { learnFromEdits: true })
    assert.equal((await call('history-edit', 'learning-api', 'Use OpenType today.')).candidates, 1)
    const proposal = (await call('corrections-list', 0, 'learning-api')).items[0]
    const accepted = await call('corrections-accept', proposal.id, 'ReviewedName', 'Opentipe')
    const learned = (await call('dictionary-list')).find((w: any) => w.id === accepted.dictionaryId)
    assert.equal(learned.sourceKind, 'history_edit'); assert.equal(learned.sourceHistoryId, 'learning-api')
    assert.equal(learned.term, 'ReviewedName')
    assert.equal((await call('corrections-list', 0, 'learning-api')).total, 0)
    await call('dictionary-remove', learned.id)
    assert.equal((await HistoryRepo.byId('learning-api'))?.editedText, 'Use OpenType today.')
    await HistoryRepo.remove('learning-api')
    console.log('OK correction settings, save/edit, review, source metadata and revoke run through actual desktop handlers')
    const audioDir=join(dir,'storage');mkdirSync(audioDir);writeFileSync(join(audioDir,'storage.wav'),'synthetic audio')
    const storage=new AudioStorage(audioDir,{isBusy:()=>false,isWriting:()=>false,changed:()=>{},now:()=>Date.now()+2*86400000})
    const storageHandlers=new Map<string,(...args:any[])=>any>(), frame={},owner={mainFrame:frame}
    registerAudioStorage(()=>storage,()=>owner as any,(channel,fn)=>storageHandlers.set(channel,fn))
    const scanStorage=storageHandlers.get('desktop:audio-storage-scan')!
    assert.throws(()=>scanStorage({sender:{},senderFrame:frame}),/audio_storage_invalid_selection/)
    assert.throws(()=>scanStorage({sender:owner,senderFrame:{}}),/audio_storage_invalid_selection/)
    const event={sender:owner,senderFrame:frame},review=await scanStorage(event)
    assert.equal(review.candidates.length,1)
    const action=storageHandlers.get('desktop:audio-storage-act')!
    assert.throws(()=>action({sender:{},senderFrame:frame},review.token,[review.candidates[0].key],'recycle'),/audio_storage_invalid_selection/)
    assert.equal(action(event,review.token,[review.candidates[0].key],'recover').completed,1)
    assert.equal((await call('history-detail','storage')).record.status,'failed')
    assert.equal((await call('history-retry','storage')).status,'completed')
    console.log('OK storage IPC rejects foreign windows/subframes and recovered audio enters existing history retry flow')


  } catch (e) {
    console.error(e)
    code = 1
  } finally {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    app.exit(code)
  }
})
