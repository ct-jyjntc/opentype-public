import { Fragment, type ReactNode } from 'react'

/** Text-only Markdown. HTML, embedded media and executable URL schemes stay inert. */
function inline(text: string, depth = 0): ReactNode {
  if (depth > 6) return text
  const pattern = /(`+)([^`\n]+)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*/g
  const parts: ReactNode[] = []; let from = 0, match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    parts.push(text.slice(from, match.index))
    const key = match.index
    if (match[1]) parts.push(<code key={key}>{match[2]}</code>)
    else if (match[3]) {
      let url: URL | undefined
      try { const parsed = new URL(match[4]); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed } catch {}
      parts.push(url ? <a key={key} href={url.href} target="_blank" rel="noopener noreferrer">{inline(match[3], depth + 1)}</a> : <Fragment key={key}>{match[3]} ({match[4]})</Fragment>)
    } else if (match[5] || match[6]) parts.push(<strong key={key}>{inline(match[5] || match[6], depth + 1)}</strong>)
    else if (match[7]) parts.push(<del key={key}>{inline(match[7], depth + 1)}</del>)
    else parts.push(<em key={key}>{inline(match[8], depth + 1)}</em>)
    from = pattern.lastIndex
  }
  parts.push(text.slice(from)); return parts
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'))
const listItem = (line: string) => /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line)
const special = (line: string) => /^(?:\s*```|\s*~~~|#{1,6}\s|>\s?|\s*(?:[-+*]|\d+[.)])\s|\s*(?:---+|\*\*\*+)\s*$)/.test(line)

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const key = i, line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const code: string[] = []; i++
      const closing = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$')
      while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>); continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>); i++; continue
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={key}/>); i++; continue }
    if (line.includes('|') && i + 1 < lines.length && cells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      const header = cells(line), rows: string[][] = []; i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push(<div className="markdown-table" key={key}><table><thead><tr>{header.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>); continue
    }
    const item = listItem(line)
    if (item) {
      const ordered = !item[1], items: ReactNode[] = [], start = ordered ? Number.parseInt(line.trim(), 10) : undefined
      while (i < lines.length) {
        const next = listItem(lines[i]); if (!next || (next[1] === undefined) !== ordered) break
        const task = /^\[([ xX])\]\s+(.+)$/.exec(next[2])
        items.push(<li key={i}>{task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} aria-label={task[1] !== ' ' ? '已完成' : '未完成'} /> {inline(task[2])}</> : inline(next[2])}</li>); i++
      }
      blocks.push(ordered ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>); continue
    }
    if (/^>/.test(line)) {
      const quoted: string[] = []; while (i < lines.length && /^>/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={key}>{inline(quoted.join('\n'))}</blockquote>); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !special(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && cells(lines[i+1]).every(s => /^:?-{3,}:?$/.test(s))) break
      paragraph.push(lines[i++])
    }
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>)
  }
  return <div className="markdown-content">{blocks}</div>
}
