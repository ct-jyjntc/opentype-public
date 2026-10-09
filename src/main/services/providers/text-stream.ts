/** Decode SSE across arbitrary UTF-8 / CRLF network boundaries. No partial success. */
export async function readTextStream(
  body: AsyncIterable<Uint8Array>,
  progress?: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = '', data: string[] = [], text = '', finished = false, done = false, lastUpdate = 0
  const dispatch = () => {
    if (!data.length) return
    const event = data.join('\n'); data = []
    if (event === '[DONE]') { done = true; return }
    if (done) throw new Error('refine_failed')
    const payload = JSON.parse(event)
    if (payload.error) throw new Error('refine_failed')
    const choice = payload.choices?.find((value: { index?: number }) => value.index === 0)
      ?? payload.choices?.[0]
    if (!choice) return // usage-only terminal event
    if (choice.delta?.reasoning_content?.trim()) throw new Error('refine_failed')
    const delta = choice.delta?.content
    if (typeof delta === 'string' && delta) {
      if (finished) throw new Error('refine_failed')
      text += delta
      if (text.length > 1_000_000) throw new Error('refine_failed')
      if (Date.now() - lastUpdate >= 80) { progress?.(text); lastUpdate = Date.now() }
    }
    if (choice.finish_reason != null) {
      if (choice.finish_reason !== 'stop') throw new Error('refine_failed')
      finished = true
    }
  }
  const line = (value: string) => {
    if (!value) { dispatch(); return }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
    if (data.reduce((size, entry) => size + entry.length, 0) > 2_000_000) throw new Error('refine_failed')
  }
  const drain = (eof = false) => {
    let match: RegExpExecArray | null
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // The next chunk may start with the LF belonging to this CR.
      if (!eof && match[0] === '\r' && match.index === buffer.length - 1) break
      const value = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      line(value)
    }
    if (buffer.length > 2_000_000) throw new Error('refine_failed')
  }
  for await (const chunk of body) {
    signal?.throwIfAborted()
    buffer += decoder.decode(chunk, { stream: true }); drain()
    if (done) break
  }
  buffer += decoder.decode(); drain(true)
  if (buffer) line(buffer)
  dispatch(); signal?.throwIfAborted()
  if (!done || !finished || !text.trim()) throw new Error('refine_failed')
  progress?.(text)
  return text.trim()
}
