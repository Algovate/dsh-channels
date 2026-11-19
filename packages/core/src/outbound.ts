/**
 * Turning one reply into the bubbles a channel can carry.
 *
 * Splitting is the core's job, not the adapter's: the limit comes from the
 * channel's capability, and the rule ("prefer a paragraph boundary") is the same everywhere.
 *
 * @module @derekluo/dsh-channels/outbound
 */

/**
 * Split text into pieces of at most `maxChars`, preferring paragraph, then
 * line, then sentence boundaries. A single over-long line is hard-split, which
 * is still better than a platform rejecting the message.
 */
export function splitIntoBubbles(text: string, maxChars: number): string[] {
  const source = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || source.length <= maxChars) return source === '' ? [] : [source]
  const out: string[] = []
  const limit = Math.max(1, Math.floor(maxChars))
  const points = Array.from(source)
  let start = 0
  while (points.length - start > limit) {
    const window = points.slice(start, start + limit).join('')
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf(' '))
    const at = cut > window.length * 0.4 ? Array.from(window.slice(0, cut + (window[cut] === '\n' ? 0 : 1))).length : limit
    out.push(points.slice(start, start + at).join('').trimEnd())
    start += at
    while (start < points.length && /\s/u.test(points[start]!)) start++
  }
  if (start < points.length) out.push(points.slice(start).join(''))
  return out.filter((piece) => piece !== '')
}

/**
 * Markdown a plain-text channel can still read.
 *
 * Deliberately conservative: bold/italic markers and inline code are unwrapped,
 * links keep their label, and fenced code is kept as-is (a code block loses all
 * meaning when its markers are stripped, so if the platform cannot render it,
 * the better answer is to send it as a file — a later milestone).
 */
export function plainText(markdown: string): string {
  let out = String(markdown ?? '')
  const fences: string[] = []
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_whole, code: string) => {
    fences.push(code.replace(/\n$/, ''))
    return `\u0000FENCE${fences.length - 1}\u0000`
  })
  for (const image of localImageReferences(out)) out = out.replace(image.markup, image.label)
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
  out = out.replace(/^#{1,6}\s+/gm, '')
  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_whole, index: string) => fences[Number(index)] ?? '')
  return out
}

/** Only standalone image paragraphs declare files; code, quotes, HTML and URLs do not. */
export function localImageReferences(markdown: string): Array<{ path: string; label: string; markup: string }> {
  const source = markdown
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<([a-z][\w:-]*)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
  const files: Array<{ path: string; label: string; markup: string }> = []
  const pattern = /^ {0,3}!\[([^\]\r\n]*)\]\([ \t]*(?:<([^>\r\n]+)>|((?:\\.|[^()\s])+))(?:[ \t]+"[^"\r\n]*")?[ \t]*\)[ \t]*$/gm
  for (const match of source.matchAll(pattern)) {
    let destination = (match[2] ?? match[3] ?? '').trim()
    if (!destination || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(destination)) continue
    try { destination = decodeURIComponent(destination) } catch { continue }
    destination = destination.replace(/\\([\\()[\] ])/g, '$1')
    if (destination.includes('\0')) continue
    files.push({ path: destination, label: match[1]?.trim() || '图片附件', markup: match[0] })
  }
  return files
}

/** WeChat collapses single newlines in chat. Blank lines keep separate instructions readable. */
export function chatParagraphs(...paragraphs: string[]): string {
  return paragraphs.filter(Boolean).join('\n\n')
}
