// 端到端链路验证（无 GUI 依赖部分）
// 用 ELECTRON_RUN_AS_NODE 运行：验证数据库、原生库、协议客户端等纯逻辑
const path = require('node:path'), os = require('node:os')
const results = []
const ok = (n, c, d) => results.push([c ? 'OK' : 'FAIL', n, d || ''])

// 1. 数据库 schema
//
// 若库不存在则用 db/index.ts 里的建表语句创建。
// 不 require 主进程产物——它在模块加载期就访问 app.getAppPath()，
// 而 e2e 跑在 ELECTRON_RUN_AS_NODE 下没有 app 对象。
// 直接复用同一份 SQL 源，避免手工建表漏掉索引。
try {
  const fs = require('node:fs')
  // 与主进程 app.setPath('userData') 保持一致（dev.opentype.desktop）。
  // 写成 'opentype' 会落到旧目录：macOS 文件系统大小写不敏感，
  // 旧目录一旦存在就会被误命中，测试看到的表结构并非运行时的那一份。
  const dbDir = path.join(os.homedir(),'Library/Application Support/dev.opentype.desktop/db')
  const dbFile = path.join(dbDir,'opentype.db')
  const D = require('better-sqlite3')
  if (!fs.existsSync(dbFile)) {
    fs.mkdirSync(dbDir, { recursive: true })
    // 从源码提取建表 SQL —— 与运行时用的是同一份定义
    const src = fs.readFileSync(path.join(process.cwd(),'src/main/db/index.ts'),'utf8')
    // 定位含 CREATE TABLE 的那段 exec(`...`)——文件里还有 ALTER 等其他 exec
    const m = src.match(/conn\.exec\(`(\s*CREATE TABLE[\s\S]*?)`\)/)
    if (!m) throw new Error('未能从 src/main/db/index.ts 提取建表 SQL')
    const tmp = new D(dbFile)
    tmp.exec(m[1])
    tmp.close()
  }
  const db = new D(dbFile, {readonly:true})
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name)
  const cols = db.prepare('PRAGMA table_info(history)').all().map(c=>c.name)
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name)
  ok('数据库表', tables.length >= 2, tables.join(', '))
  ok('history 列数', cols.length >= 35, String(cols.length))
  ok('索引数', idx.length >= 6, String(idx.length))
  db.close()
} catch (e) { ok('数据库', false, e.message) }

// 2. 四个原生库 + 关键函数
try {
  const koffi = require('koffi')
  const libDir = path.join(process.cwd(), 'native')
  const load = (g,f) => koffi.load(path.join(libDir,g,'build',f))
  const ctx = load('context-helper','libContextHelper.dylib')
  const util = load('util-helper','libUtilHelper.dylib')
  const kb = load('keyboard-helper','libKeyboardHelper.dylib')
  const inp = load('input-helper','libInputHelper.dylib')
  ok('原生库加载', true, '4/4')

  const nb = ctx.func('needsBottomUpURLTraversal','bool',['str'])
  ok('白名单(Chromium)', nb('org.chromium.Chromium'), '')
  ok('白名单(Safari)', nb('com.apple.Safari'), '')
  ok('白名单(Chrome 排除)', nb('com.google.Chrome') === false, '')

  const ib = ctx.func('isBrowserApp','bool',['str'])
  ok('浏览器前缀匹配', ib('com.google.Chrome.canary') && ib('ai.perplexity.comet'), '')

  const fid = util.func('getDeviceId','void*',[])
  ok('设备 ID 可用', fid() !== null, '')

  const st = inp.func('getCurrentInputState','void*',[])
  ok('输入状态可用', st() !== null, '')
  void kb
} catch (e) { ok('原生库', false, e.message) }

// 3. 主进程产物的语法有效性（在 Electron 环境外加载会因 app 未定义而失败，
//    这里只验证它是合法 CJS 且能被解析，不实际执行顶层逻辑）
try {
  const src = require('node:fs').readFileSync(path.join(process.cwd(),'dist/main/index.js'),'utf8')
  const check = new (require('node:vm').Script)(src, { filename: 'main.js' })
  ok('主进程产物语法有效', check !== null, `${(src.length/1024).toFixed(1)}KB`)
} catch (e) { ok('主进程产物语法', false, e.message.slice(0,60)) }

// 3b. 渲染层不能白屏：worklet 代码必须与主包隔离。
//
// 曾经的缺陷：capture-manager 从 worklet.ts 导入常量，导致整个 worklet
// 模块被打进主渲染包；AudioWorkletProcessor 在主线程不存在，一执行就抛
// ReferenceError，React 挂载失败 → 白屏（#root 内容长度为 0）。
// 这条断言从构建产物层面拦截该回归。
try {
  const assetsDir = path.join(process.cwd(),'dist/renderer/assets')
  const files = require('node:fs').readdirSync(assetsDir)
  const mainBundle = files.find((f) => f.startsWith('index-') && f.endsWith('.js'))
  if (!mainBundle) throw new Error('未找到主渲染包')
  const mainCode = require('node:fs').readFileSync(path.join(assetsDir, mainBundle),'utf8')

  ok('主包不含 AudioWorkletProcessor', !mainCode.includes('AudioWorkletProcessor'),
     '白屏根因防护')

  const workletBundle = files.find((f) => f.startsWith('worklet-') && f.endsWith('.js'))
  ok('worklet 独立产物存在', Boolean(workletBundle), workletBundle ?? '缺失')
  if (workletBundle) {
    const wCode = require('node:fs').readFileSync(path.join(assetsDir, workletBundle),'utf8')
    ok('worklet 含 registerProcessor', wCode.includes('registerProcessor'), '')
  }

  // 主包也不该引用 AudioContext 之外的主线程不可用 API
  ok('主包不含 registerProcessor', !mainCode.includes('registerProcessor'), '')
} catch (e) { ok('渲染层产物检查', false, e.message.slice(0,50)) }

// 4. worklet 产物可被 addModule 加载（自包含 + 含 registerProcessor）
try {
  const dir = path.join(process.cwd(),'dist/renderer/assets')
  const wf = require('node:fs').readdirSync(dir).find(f => f.startsWith('worklet') && f.endsWith('.js'))
  if (!wf) throw new Error('worklet 产物缺失')
  const code = require('node:fs').readFileSync(path.join(dir,wf),'utf8')
  ok('worklet 产物', code.includes('registerProcessor') && !/^import\s/m.test(code), wf)
} catch (e) { ok('worklet 产物', false, e.message.slice(0,50)) }

console.log('=== 端到端链路验证 ===')
let failed = 0
for (const [s,n,d] of results) { if (s==='FAIL') failed++; console.log(`${s.padEnd(5)} ${n.padEnd(22)} ${d}`) }
console.log(`\n${results.length-failed}/${results.length} 通过`)
process.exit(failed > 0 ? 1 : 0)
