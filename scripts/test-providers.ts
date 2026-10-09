// provider 协议构造测试。
//
// 核心验证点：两个 provider 发出的请求形状是否符合各自协议。
// 协议错了服务端会直接拒绝，且错误信息通常不明确——所以这里逐字段核对。

import { createProvider, FallbackProvider } from '../src/main/services/providers/index.ts'
import { normalizeGrounding } from '../src/main/services/providers/types.ts'
import { SERVER_MODE } from '../src/main/services/protocol.ts'
import {
  SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_COUNT, LANGUAGE_VARIANTS,
  isSupportedLanguage, languageDisplayName
} from '../src/main/services/languages.ts'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed++; console.log(`  OK   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}\n       实际: ${a}\n       期望: ${e}`) }
}

console.log('\n=== provider 工厂 ===')
{
  const base = { baseUrl: 'https://api.test', appVersion: '0.1.0' }
  check('custom', createProvider({ ...base, kind: 'custom' }).name, 'custom')
  check('openai', createProvider({ ...base, kind: 'openai' }).name, 'openai')
  check('local', createProvider({ ...base, kind: 'local' }).name, 'local')
  // 未知类型回退到 local，而不是抛错
  check('未知类型回退 local', createProvider({ ...base, kind: 'bogus' as never }).name, 'local')
}

console.log('\n=== 协议常量核对 ===')
// 这两个映射是协议约定，错了服务端会走错分支
check('voice_transcript → transcript', SERVER_MODE.voice_transcript, 'transcript')
check('voice_command → ask_anything', SERVER_MODE.voice_command, 'ask_anything')
check('voice_translation → translation', SERVER_MODE.voice_translation, 'translation')

console.log('\n=== FallbackProvider 转移策略 ===')
{
  // 用一个可控的假 provider 验证转移条件
  const mk = (name: string, result: any) => ({
    name,
    transcribe: async () => result
  })

  // 主成功 → 不转移
  {
    const p = new FallbackProvider(
      mk('primary', { success: true, text: 'ok' }),
      mk('fallback', { success: true, text: 'fb' })
    )
    const r = await p.transcribe({} as never)
    check('主成功不转移', r.text, 'ok')
    check('名称组合', p.name, 'primary+fallback')
  }

  // 主配额不足 → 不转移（转移也无意义）
  {
    const p = new FallbackProvider(
      mk('primary', { success: false, paywall: { plan: 'pro' } }),
      mk('fallback', { success: true, text: 'fb' })
    )
    const r = await p.transcribe({} as never)
    check('配额不足不转移', r.paywall, { plan: 'pro' })
  }

  // 主超时 → 转移（可能是主服务端慢，本地可能更快）
  {
    const p = new FallbackProvider(
      mk('primary', { success: false, detail: 'timeout' }),
      mk('fallback', { success: true, text: 'local-result' })
    )
    const r = await p.transcribe({} as never)
    check('超时转移到本地', r.text, 'local-result')
  }

  // 主服务不可用 → 转移
  {
    const p = new FallbackProvider(
      mk('primary', { success: false, detail: 'ECONNREFUSED' }),
      mk('fallback', { success: true, text: 'local-result' })
    )
    const r = await p.transcribe({} as never)
    check('连接失败转移到本地', r.text, 'local-result')
  }

  // 两边都失败 → 返回主 provider 的错误（更可能是用户关心的）
  {
    const p = new FallbackProvider(
      mk('primary', { success: false, detail: 'primary-error' }),
      mk('fallback', { success: false, detail: 'fallback-error' })
    )
    const r = await p.transcribe({} as never)
    check('双失败返回主错误', r.detail, 'primary-error')
  }
}

console.log('\n=== OpenAI provider 的润色指令覆盖 ===')
{
  // 三种模式都必须有对应指令，缺了会退化成通用润色
  const fs = await import('node:fs')
  const path = await import('node:path')
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/main/services/providers/openai.ts'), 'utf8'
  )
  for (const mode of ['voice_transcript', 'voice_command', 'voice_translation']) {
    check(`${mode} 有润色指令`, src.includes(`${mode}:`), true)
  }
  // 关键字段名必须是 OpenAI 的 file 而非自建协议的 audio_file
  check('使用 OpenAI 的 file 字段', src.includes("form.append('file'"), true)
  check('未误用 audio_file', src.includes("form.append('audio_file'"), false)
  // 端点必须带 /v1 前缀
  check('transcriptions 端点', src.includes('/v1/audio/transcriptions'), true)
  check('chat 端点', src.includes('/v1/chat/completions'), true)
}

console.log('\n=== 自建协议 provider 的字段名 ===')
{
  const fs2 = await import('node:fs')
  const path2 = await import('node:path')
  const src = fs2.readFileSync(
    path2.join(process.cwd(), 'src/main/services/providers/custom.ts'), 'utf8'
  )
  check('使用 audio_file 字段', src.includes("form.append('audio_file'"), true)
  check('端点 /ai/voice_flow', src.includes('/ai/voice_flow'), true)
  check('上传服务端 mode 值', src.includes('SERVER_MODE[params.mode]'), true)
  check('含 audio_context', src.includes("form.append('audio_context'"), true)
  check('含 parameters', src.includes("form.append('parameters'"), true)
}

console.log('\n=== 语言支持（112 种）===')
{
  check('语言总数', SUPPORTED_LANGUAGE_COUNT, 112)
  check('中文可用', isSupportedLanguage('zh-CN'), true)
  check('英文可用', isSupportedLanguage('en'), true)
  check('日文可用', isSupportedLanguage('ja'), true)
  check('小语种可用（冰岛语）', isSupportedLanguage('is'), true)
  check('未知语言被拒', isSupportedLanguage('xx-YY'), false)
  check('展示名查询', languageDisplayName('ja'), 'Japanese')
  check('未知代码原样返回', languageDisplayName('xx'), 'xx')
  // 有变体的只有 5 种语言（依据界面文案）
  check('变体语言数', Object.keys(LANGUAGE_VARIANTS).length, 5)
  check('中文有 3 种变体', LANGUAGE_VARIANTS.zh.length, 3)
  check('英文有 5 种变体', LANGUAGE_VARIANTS.en.length, 5)
  // 变体代码都应是受支持的语言
  const allVariants = Object.values(LANGUAGE_VARIANTS).flat()
  check('变体代码均受支持', allVariants.every((c) => isSupportedLanguage(c)), true)
}

console.log('\n=== 联网引用归一化 ===')
{
  // 服务端返回嵌套结构，需拍平成前端可用的形式
  const raw = {
    grounding_chunks: [
      { web: { domain: 'example.com', title: '示例', uri: 'https://example.com/a', icon_url: 'https://example.com/i.png' } },
      { web: { domain: 'docs.test', title: '文档', uri: 'https://docs.test/b', icon_url: '' } }
    ],
    grounding_supports: [
      { start_index: 0, end_index: 12, chunk_indices: [0] },
      { start_index: 13, end_index: 30, chunk_indices: [1, 0] }
    ]
  }
  const g = normalizeGrounding(raw)
  check('chunks 数量', g?.chunks.length, 2)
  check('domain 拍平', g?.chunks[0].domain, 'example.com')
  check('title 拍平', g?.chunks[0].title, '示例')
  check('uri 拍平', g?.chunks[0].uri, 'https://example.com/a')
  check('icon_url 拍平为 iconUrl', g?.chunks[0].iconUrl, 'https://example.com/i.png')
  check('index 自动编号', g?.chunks[1].index, 1)
  check('supports 数量', g?.supports.length, 2)
  check('supports 偏移映射', [g?.supports[0].startIndex, g?.supports[0].endIndex], [0, 12])
  check('多 chunk 引用', g?.supports[1].chunkIndices, [1, 0])

  // 无数据时返回 undefined 而非空对象（调用方据此判断是否渲染引用区）
  check('空数据返回 undefined', normalizeGrounding({}), undefined)
  check('null 返回 undefined', normalizeGrounding(null), undefined)
  check('chunks 为空返回 undefined', normalizeGrounding({ grounding_chunks: [] }), undefined)
}

console.log(`\n${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
