/** The static channel table: a new adapter needs an entry here. */
export const PKG = '@derekluo/dsh-channels'

export const CHANNELS = [
  { id: 'weixin', row: 'weixin-user', badge: { en: 'WeChat', zh: '微信' }, accent: '#07C160', accentSoft: 'rgba(7, 193, 96, 0.12)' },
  { id: 'telegram', row: 'telegram-user', badge: { en: 'Telegram', zh: '电报' }, accent: '#2AABEE', accentSoft: 'rgba(42, 171, 238, 0.12)' },
  { id: 'feishu', row: 'feishu-user', badge: { en: 'Feishu', zh: '飞书' }, accent: '#3370FF', accentSoft: 'rgba(51, 112, 255, 0.12)' },
]

export const byKind = new Map(CHANNELS.map((channel) => [channel.id, channel]))

/** Bilingual lookup without a locale round trip: the row ships two strings. */
export function translator() {
  const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
  const chinese = lang.startsWith('zh')
  return (en, zh) => (chinese ? zh : en)
}

/** A wxid is long and uniform; twelve characters are enough to tell people apart. */
export function shortSender(senderId) {
  const value = String(senderId ?? '')
  const at = value.indexOf('@')
  const name = at > 0 ? value.slice(0, at) : value
  return name.length > 12 ? `${name.slice(0, 12)}…` : name
}

/**
 * Renderer-ready data of one channel row.
 *
 * Built from the durable event only, and nothing here may throw: a malformed
 * event renders as an empty row instead of blanking the transcript.
 */
export function rowData(message) {
  const source = message?.source ?? {}
  const blocks = Array.isArray(message?.content) ? message.content : []
  const content = source.hasOutputInstruction === true ? blocks.slice(1) : blocks
  const texts = []
  let others = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block !== null && block !== undefined) others += 1
  }
  return {
    text: texts.join('\n').trim(),
    others,
    group: source.group === true,
    senderId: typeof source.senderId === 'string' ? source.senderId : '',
  }
}
