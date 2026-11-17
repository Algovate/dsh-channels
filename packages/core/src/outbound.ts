/**
 * Turning one reply into the bubbles a channel can carry.
 *
 * Splitting is the core's job, not the adapter's: the limit comes from the
 * channel's capability, and the rule ("never cut a code fence in half, prefer a
 * paragraph boundary") is the same everywhere.
 *
 * @module @rodin/dsh-channels/outbound
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
  let rest = source
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf(' '))
    const at = cut > maxChars * 0.4 ? cut + (window[cut] === '\n' ? 0 : 1) : maxChars
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest !== '') out.push(rest)
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
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
  out = out.replace(/^#{1,6}\s+/gm, '')
  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_whole, index: string) => fences[Number(index)] ?? '')
  return out
}
