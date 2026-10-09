import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { initDatabase, closeDatabase, HistoryRepo, DictionaryRepo, CorrectionRepo, type HistoryInsert } from '../src/main/db'
import { extractCorrections } from '../src/main/services/correction-extraction'
import { refineTranscript } from '../src/main/services/providers/refinement'
const dir = mkdtempSync(join(tmpdir(), 'opentype-correction-test-'))
let count = 0
async function test(name: string, fn: () => Promise<void> | void) { await fn(); count++; console.log('OK ' + name) }
const seed = async (id: string, extra: Partial<HistoryInsert> = {}) => HistoryRepo.upsert({ id, refinedText: '请使用欧朋太谱完成听写。', status: 'completed', mode: 'voice_transcript', focusedAppName: 'Synthetic editor', focusedAppBundleId: 'test.editor', createdAt: new Date().toISOString(), ...extra })
const edited = '请使用OpenType完成听写。'
try {
  // A pre-feature dictionary must survive startup migration with its IDs and hints intact.
  mkdirSync(join(dir, 'db'))
  const old = new Database(join(dir, 'db/opentype.db'))
  old.exec('CREATE TABLE dictionary (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, term TEXT NOT NULL, pronunciation TEXT, created_at TEXT)')
  old.prepare('INSERT INTO dictionary VALUES (?, ?, ?, ?, ?)').run('existing-word', 'local', 'ExistingName', 'existing hint', '2026-01-01')
  old.close(); initDatabase(join(dir, 'db'))
  await test('old dictionary migration preserves terms and adds source metadata', async () => {
    const words = await DictionaryRepo.list('local')
    assert.equal(words[0].id, 'existing-word'); assert.equal(words[0].pronunciation, 'existing hint')
    assert.equal(words[0].sourceKind, null); assert.equal(words[0].sourceHistoryId, null)
  })
  await test('word-level proposals include complete names and multiple separate corrections', () => {
    assert.deepEqual(extractCorrections('请使用欧朋太谱完成听写。', edited), [{ original: '欧朋太谱', replacement: 'OpenType' }])
    assert.deepEqual(extractCorrections('Use Opentipe and SenceVoice today.', 'Use OpenType and SenseVoice today.'), [
      { original: 'Opentipe', replacement: 'OpenType' }, { original: 'SenceVoice', replacement: 'SenseVoice' },
    ])
    assert.deepEqual(extractCorrections('Use Opentipe, Opentipe.', 'Use OpenType, OpenType.'), [{ original: 'Opentipe', replacement: 'OpenType' }])
  })
  await test('punctuation, spacing, numbers, insertions, URLs, code and broad rewrites do not become terms', () => {
    for (const [a, b] of [
      ['你好,世界.', '你好，世界。'], ['中文ABC', '中文 ABC'], ['价格85折', '价格8.5折'], ['明天开会', '后天开会'],
      ['今天开会', '今天下午开会'], ['Use https://opentipe.com', 'Use https://opentype.com'],
      ['const x = Opentipe;', 'const x = OpenType;'], ['```\nOpentipe\n```', '```\nOpenType\n```'],
      ['a@opentipe.com', 'a@opentype.com'], ['a '.repeat(1000), 'b '.repeat(1000)],
    ]) assert.deepEqual(extractCorrections(a, b), [], `${a} -> ${b}`)
  })
  await test('saving explicit edits creates local pending proposals and never changes dictionary or raw text', async () => {
    await seed('edit', { modeMeta: JSON.stringify({ raw_text: 'ASR source' }) })
    assert.equal(CorrectionRepo.saveEdit('edit', edited, true).candidates, 1)
    assert.equal((await DictionaryRepo.list('local')).length, 1)
    assert.equal((await HistoryRepo.byId('edit'))?.editedText, edited)
    assert.equal(JSON.parse(String((await HistoryRepo.byId('edit'))?.modeMeta)).raw_text, 'ASR source')
    assert.equal(CorrectionRepo.list(0, 'edit').items[0].replacement, 'OpenType')
    assert.equal(CorrectionRepo.saveEdit('edit', edited, true).candidates, 1)
    assert.equal(CorrectionRepo.list(0, 'edit').total, 1)
  })
  await test('explicit confirmation creates a sourced dictionary term; retries are idempotent', async () => {
    const c = CorrectionRepo.list(0, 'edit').items[0]
    const result = CorrectionRepo.accept(c.id, c.replacement, c.original)
    assert.equal(result.added, true)
    assert.equal(CorrectionRepo.accept(c.id, c.replacement, c.original).added, false)
    const word = (await DictionaryRepo.list('local')).find(w => w.id === result.dictionaryId)!
    assert.equal(word.term, 'OpenType'); assert.equal(word.pronunciation, '欧朋太谱')
    assert.equal(word.sourceHistoryId, 'edit'); assert.equal(word.sourceKind, 'history_edit')
    assert.equal(CorrectionRepo.list(0, 'edit').total, 0)
  })
  await test('confirmed words reach the text refinement request while unconfirmed source history stays local', async () => {
    const previous = getGlobalDispatcher(), mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock)
    try {
      const words = (await DictionaryRepo.list('local')).slice(0, 200).map(w => ({ term: w.term, hint: w.pronunciation }))
      mock.get('https://api.deepseek.com').intercept({ path: '/chat/completions', method: 'POST' }).reply(options => {
        const data = JSON.parse(JSON.parse(String(options.body)).messages[1].content)
        assert(data.dictionary.some((w: any) => w.term === 'OpenType' && w.hint === '欧朋太谱'))
        assert(!String(options.body).includes('ASR source'))
        assert(!String(options.body).includes('sourceHistoryId'))
        return { statusCode: 200, data: { choices: [{ finish_reason: 'stop', message: { content: 'Use OpenType.' } }] } }
      })
      const r = await refineTranscript('Use 欧朋太谱.', { mode: 'voice_transcript', audio: new Uint8Array(), audioId: 'synthetic', duration: 0, audioContext: {}, audioMetadata: {}, parameters: { dictionary: words } }, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'synthetic', enabled: true, apiKey: 'synthetic' })
      assert.equal(r.success, true); mock.assertNoPendingInterceptors()
    } finally { setGlobalDispatcher(previous); await mock.close() }
  })
  await test('source deletion clears candidates and source link; confirmed dictionary word survives until explicitly removed', async () => {
    await HistoryRepo.remove('edit')
    assert.equal(CorrectionRepo.list(0, 'edit').total, 0)
    const word = (await DictionaryRepo.list('local')).find(w => w.term === 'OpenType')!
    assert.equal(word.sourceHistoryId, null); assert.equal(word.sourceKind, 'history_edit')
    await DictionaryRepo.remove('local', word.id)
    assert(!(await DictionaryRepo.list('local')).some(w => w.term === 'OpenType'))
  })
  await test('dismissed corrections do not return on repeated save; rejected review never changes existing words', async () => {
    await seed('dismiss'); CorrectionRepo.saveEdit('dismiss', edited, true)
    const c = CorrectionRepo.list(0, 'dismiss').items[0]
    CorrectionRepo.dismiss(c.id); CorrectionRepo.saveEdit('dismiss', edited, true)
    assert.equal(CorrectionRepo.list(0, 'dismiss').total, 0)
    assert.throws(() => CorrectionRepo.accept(c.id, 'OpenType', ''), /correction_stale/)
    await seed('invalid'); CorrectionRepo.saveEdit('invalid', edited, true)
    const invalid = CorrectionRepo.list(0, 'invalid').items[0]
    assert.throws(() => CorrectionRepo.accept(invalid.id, '', ''), /empty_term/)
    assert.equal(CorrectionRepo.list(0, 'invalid').total, 1)
  })
  await test('case-insensitive duplicate confirmation preserves manual spelling, hint and ownership', async () => {
    await seed('duplicate'); CorrectionRepo.saveEdit('duplicate', edited, true)
    const c = CorrectionRepo.list(0, 'duplicate').items[0]
    const result = CorrectionRepo.accept(c.id, 'existingname', 'do not overwrite')
    assert.equal(result.added, false); assert.equal(result.dictionaryId, 'existing-word')
    const word = (await DictionaryRepo.list('local')).find(w => w.id === 'existing-word')!
    assert.equal(word.term, 'ExistingName'); assert.equal(word.pronunciation, 'existing hint'); assert.equal(word.sourceKind, null)
  })
  await test('disabled learning, translation, commands, incomplete and protected records save edits without proposals', async () => {
    await seed('disabled'); assert.equal(CorrectionRepo.saveEdit('disabled', edited, false).candidates, 0)
    for (const [id, extra] of [
      ['translation', { mode: 'voice_translation' }], ['command', { mode: 'voice_command' }], ['failed', { status: 'failed' }],
      ['secure', { audioContext: JSON.stringify({ role: 'AXSecureTextField' }) }],
      ['redacted', { audioContext: JSON.stringify({ redacted: true }) }],
    ] as [string, Partial<HistoryInsert>][]) {
      await seed(id, extra); assert.equal(CorrectionRepo.saveEdit(id, edited, true).candidates, 0, id)
      assert.equal((await HistoryRepo.byId(id))?.editedText, edited)
    }
    await seed('domain', { audioContext: JSON.stringify({ web_url: 'https://private.invalid' }) })
    assert.equal(CorrectionRepo.saveEdit('domain', edited, true, ['private.invalid']).candidates, 0)
    CorrectionRepo.saveEdit('domain', edited, true)
    assert.throws(() => CorrectionRepo.accept(CorrectionRepo.list(0, 'domain').items[0].id, 'OpenType', '', ['private.invalid']), /correction_stale/)
  })
  await test('subsequent edits, retries, sync replacements and deletion invalidate stale proposals', async () => {
    for (const operation of ['revert', 'retry', 'sync', 'delete']) {
      await seed(operation); CorrectionRepo.saveEdit(operation, edited, true)
      const c = CorrectionRepo.list(0, operation).items[0]
      if (operation === 'revert') CorrectionRepo.saveEdit(operation, '请使用欧朋太谱完成听写。', true)
      if (operation === 'retry') await HistoryRepo.upsert({ id: operation, editedText: null })
      if (operation === 'sync') await HistoryRepo.upsert({ id: operation, refinedText: 'different result' })
      if (operation === 'delete') await HistoryRepo.remove(operation)
      assert.equal(CorrectionRepo.list(0, operation).total, 0)
      assert.throws(() => CorrectionRepo.accept(c.id, 'OpenType', ''), /correction_stale/)
    }
  })
  await test('removing a learned word revokes it without reverting the edit or resurrecting the proposal', async () => {
    await seed('undo'); CorrectionRepo.saveEdit('undo', edited, true)
    const c = CorrectionRepo.list(0, 'undo').items[0], result = CorrectionRepo.accept(c.id, 'OpenType', '欧朋太谱')
    await DictionaryRepo.remove('local', result.dictionaryId)
    assert.equal((await HistoryRepo.byId('undo'))?.editedText, edited)
    CorrectionRepo.saveEdit('undo', edited, true)
    assert.equal(CorrectionRepo.list(0, 'undo').total, 0)
    assert.throws(() => CorrectionRepo.accept(c.id, 'OpenType', ''), /correction_stale/)
  })
  await test('long and empty edits are saved verbatim without silent truncation or raw-history destruction', async () => {
    await seed('long'); const long = '测'.repeat(100_001)
    assert.equal(CorrectionRepo.saveEdit('long', long, true).candidates, 0)
    assert.equal((await HistoryRepo.byId('long'))?.editedText, long)
    CorrectionRepo.saveEdit('long', '', true); assert.equal((await HistoryRepo.byId('long'))?.editedText, '')
    assert.throws(() => CorrectionRepo.saveEdit('long', 'x'.repeat(1_000_001), true), /invalid_history_text/)
    assert.equal((await HistoryRepo.byId('long'))?.editedText, '')
  })
  await test('pending, accepted and dismissed decisions persist after restart; history clear removes all candidate text', async () => {
    await seed('restart'); CorrectionRepo.saveEdit('restart', edited, true)
    closeDatabase(); initDatabase(join(dir, 'db'))
    assert.equal(CorrectionRepo.list(0, 'restart').total, 1)
    assert.equal(CorrectionRepo.list(0, 'dismiss').total, 0)
    assert.equal(CorrectionRepo.list(0, 'undo').total, 0)
    await HistoryRepo.clear()
    assert.equal(CorrectionRepo.list().total, 0)
    const check = new Database(join(dir, 'db/opentype.db'))
    assert.equal((check.prepare('SELECT count(*) AS count FROM correction_candidates').get() as { count: number }).count, 0)
    check.close()
    assert((await DictionaryRepo.list('local')).some(w => w.id === 'existing-word'))
  })

  await test('pending pagination is stable and real remote deletion cascades without touching an accepted word', async () => {
    for (let n = 0; n < 55; n++) { await seed('page-' + n); CorrectionRepo.saveEdit('page-' + n, edited, true) }
    const first = CorrectionRepo.list(), second = CorrectionRepo.list(50)
    assert.equal(first.items.length, 50); assert.equal(second.items.length, 5)
    assert.equal(new Set([...first.items, ...second.items].map(c => c.id)).size, 55)
    assert.equal(first.total, 55); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false)
    const account = { userId: 'test-owner', serverUrl: 'https://synthetic.invalid' }
    await seed('remote-pending', { userId: account.userId, cloudScope: account.serverUrl }); CorrectionRepo.saveEdit('remote-pending', edited, true)
    await seed('remote-accepted', { userId: account.userId, cloudScope: account.serverUrl }); CorrectionRepo.saveEdit('remote-accepted', edited, true)
    const c = CorrectionRepo.list(0, 'remote-accepted').items[0]
    const accepted = CorrectionRepo.accept(c.id, c.replacement, c.original)
    assert.equal((await HistoryRepo.applyRemoteDeletions(['remote-pending','remote-accepted'], account)).length, 2)
    assert.equal(CorrectionRepo.list(0, 'remote-pending').total, 0)
    const word = (await DictionaryRepo.list('local')).find(w => w.id === accepted.dictionaryId)!
    assert.equal(word.sourceHistoryId, null); assert.equal(word.term, 'OpenType')
    await HistoryRepo.clear()
    await DictionaryRepo.remove('local', accepted.dictionaryId)
  })
  console.log(`${count} correction learning scenarios passed`)
} finally { closeDatabase(); rmSync(dir, { recursive: true, force: true }) }
