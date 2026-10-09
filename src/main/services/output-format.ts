import { readOutputPreferences, type OutputPreferences } from '../../shared/output-preferences'
import type { TranscribeParams, TranscribeResult } from './providers/types'

// Do not rewrite explicit code, addresses, paths or Markdown destinations.
const protectedText = /`+[^`\n]*`+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|!?\[[^\]\n]*\]\([^\n)]*\)|(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>，。！？；、]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[a-z]:[\\/]|\.{0,2}\/|~\/)[^\s<>，。！？；、]+|[\p{L}\d_-]+(?:\.[a-z][a-z\d_-]*)+|\d+(?:\.\d+)+/giu
const technicalLine = /^\s*(?:\{|\[|<|\$\s|#!|(?:const|let|var|import|export|return|def|class|function|SELECT|INSERT|UPDATE|DELETE|curl|npm|git|python|node)\s)|(?:=>|:=|==|!=|\w\s*=)|^\s*[A-Za-z_][\w.-]*:\s+/u
const han = /\p{Script=Han}/u

function formatLine(line: string, options: OutputPreferences) {
  if (/^(?: {4}|\t)/.test(line) || technicalLine.test(line)) return line
  const ranges = () => [...line.matchAll(protectedText)].map(m => [m.index!, m.index! + m[0].length])
  const spans = ranges()
  if (options.punctuation === 'chinese') {
    line = line.replace(/[,;:!?.]/g, (mark, offset: number, source: string) => {
      if (spans.some(([a, b]) => offset >= a && offset < b)) return mark
      const before = source.slice(0, offset).trimEnd().slice(-1)
      const after = source.slice(offset + 1).trimStart().slice(0, 1)
      // No inferred punctuation and no numeric changes. Periods need Han before them.
      if (mark === '.' ? !han.test(before) || /[\w.]/.test(after) : !han.test(before) && !han.test(after)) return mark
      return ({ ',': '，', ';': '；', ':': '：', '!': '！', '?': '？', '.': '。' })[mark]!
    })
  }
  if (options.spacing !== 'preserve') {
    const gap = options.spacing === 'space' ? ' ' : ''
    for (const pattern of [/(\p{Script=Han})([ \t]*)([A-Za-z0-9])/gu, /([A-Za-z0-9])([ \t]*)(\p{Script=Han})/gu]) {
      const protectedSpans = ranges()
      line = line.replace(pattern, (whole, left: string, _space: string, right: string, offset: number) => {
        // Boundary whitespace may change, bytes inside a protected token may not.
        const at = offset + left.length
        return protectedSpans.some(([a, b]) => at > a && at < b) ? whole : left + gap + right
      })
    }
  }
  return line
}

export function formatDictation(text: string, options: OutputPreferences): string {
  if (options.punctuation === 'preserve' && options.spacing === 'preserve') return text
  // Track fences by line, including unterminated blocks. Preserve line endings.
  let fence: { char: string; size: number } | undefined
  return text.split(/(\r?\n)/).map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = undefined
      return line
    }
    if (marker) { fence = { char: marker[1][0], size: marker[1].length }; return line }
    return formatLine(line, options)
  }).join('')
}

/** One final pass for ordinary dictation, shared by live capture and history retry. */
export function applyOutputPreferences(result: TranscribeResult, params: TranscribeParams): TranscribeResult {
  if (params.mode !== 'voice_transcript' || !result.success || !result.text || result.delivery === 'external') return result
  const text = formatDictation(result.text, readOutputPreferences(params.parameters?.output_preferences))
  return text === result.text ? result : { ...result, text, rawText: result.rawText ?? result.text }
}
