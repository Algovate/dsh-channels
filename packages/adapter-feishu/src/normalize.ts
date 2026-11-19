/**
 * Feishu/Lark long-connection event → one normalized inbound message (or none).
 *
 * Two v2.0 events matter: `im.message.receive_v1` (a person sent the bot a
 * message) and `card.action.trigger` (a person tapped a native button the
 * adapter sent). Everything else — bot/app senders, edits, unsupported message
 * types, malformed envelopes — is refused with `null`, the same rule the
 * Telegram adapter follows: an event a person did not type is not a turn.
 *
 * @module @derekluo/dsh-channels-feishu/normalize
 */
import type { InboundMedia, InboundMessage } from '@derekluo/dsh-channels'

export const CHANNEL_ID = 'feishu'

/** The v2.0 event envelope the persistent connection delivers after reassembly. */
export interface FeishuEnvelope {
  schema?: string
  header?: {
    event_id?: string
    event_type?: string
    create_time?: string
    token?: string
    app_id?: string
    tenant_key?: string
  }
  event?: FeishuEvent
}

interface FeishuEvent {
  sender?: {
    sender_type?: string
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
  }
  message?: {
    message_id?: string
    root_id?: string
    parent_id?: string
    create_time?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: Array<{ key?: string; name?: string }>
  }
  context?: { open_message_id?: string; open_chat_id?: string }
  open_message_id?: string
  open_chat_id?: string
  token?: string
  operator?: { open_id?: string; union_id?: string; name?: string }
  action?: { value?: unknown; tag?: string; name?: string }
  [key: string]: unknown
}

/** One attachment as Feishu named it, before the adapter downloads it. */
export interface RawMedia {
  kind: InboundMedia['kind']
  fileKey: string
  /** The message that owns the resource; the download path is keyed by it. */
  messageId: string
  /** The `type` query the resources endpoint expects. */
  type: string
  fileName?: string
  mime?: string
}

export interface NormalizedInbound extends InboundMessage {
  /** Attachment descriptors this event carries, downloaded before handoff. */
  mediaItems?: RawMedia[]
  /** Present when this input came from a card button; used to answer the callback. */
  cardCallbackToken?: string
}

interface ParsedContent {
  text: string
  media: RawMedia[]
}

type FeishuMention = { key?: string; name?: string }

/** Flatten a `post` rich-text body into plain lines, keeping links and @names. */
function postText(content: Record<string, unknown>, mentions: FeishuMention[] | undefined): string {
  const localeBody = (content['zh_cn'] ?? content['en_us'] ?? content['ja_jp'] ?? content) as { title?: string; content?: unknown }
  const lines: string[] = []
  if (typeof localeBody.title === 'string' && localeBody.title !== '') lines.push(localeBody.title)
  const paragraphs = Array.isArray(localeBody.content) ? localeBody.content : []
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const element of paragraph as Array<Record<string, unknown>>) {
      const tag = typeof element['tag'] === 'string' ? element['tag'] : ''
      if (tag === 'text' || tag === 'a') line += String(element['text'] ?? '')
      else if (tag === 'at') line += typeof element['user_name'] === 'string' ? `@${element['user_name']}` : '@all'
      else if (tag === 'a' && typeof element['href'] === 'string') line += String(element['text'] ?? element['href'])
    }
    lines.push(line)
  }
  let text = lines.join('\n').trim()
  for (const mention of mentions ?? []) {
    if (typeof mention?.key === 'string' && typeof mention.name === 'string') text = text.replaceAll(mention.key, `@${mention.name}`)
  }
  return text
}

/** Parse one message's JSON content into words and attachment descriptors. */
function parseContent(messageType: string, raw: string, messageId: string, mentions: FeishuMention[] | undefined): ParsedContent {
  let content: Record<string, unknown>
  try {
    content = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { text: '', media: [] }
  }
  const media: RawMedia[] = []
  switch (messageType) {
    case 'text': {
      let text = typeof content['text'] === 'string' ? content['text'] : ''
      for (const mention of mentions ?? []) {
        if (typeof mention?.key === 'string' && typeof mention.name === 'string') text = text.replaceAll(mention.key, `@${mention.name}`)
      }
      return { text: text.trim(), media }
    }
    case 'post':
      return { text: postText(content, mentions), media }
    case 'image':
      if (typeof content['image_key'] === 'string') {
        media.push({ kind: 'image', fileKey: content['image_key'], messageId, type: 'image', mime: 'image/jpeg' })
      }
      return { text: '', media }
    case 'file':
      if (typeof content['file_key'] === 'string') {
        media.push({
          kind: 'file', fileKey: content['file_key'], messageId, type: 'file',
          ...(typeof content['file_name'] === 'string' ? { fileName: content['file_name'] } : {}),
          mime: 'application/octet-stream',
        })
      }
      return { text: '', media }
    case 'audio':
      if (typeof content['file_key'] === 'string') {
        media.push({ kind: 'voice', fileKey: content['file_key'], messageId, type: 'audio', mime: 'audio/ogg' })
      }
      return { text: '', media }
    case 'video':
    case 'media':
      if (typeof content['file_key'] === 'string') {
        media.push({
          kind: 'video', fileKey: content['file_key'], messageId, type: 'video',
          ...(typeof content['file_name'] === 'string' ? { fileName: content['file_name'] } : {}),
          mime: 'video/mp4',
        })
      }
      return { text: '', media }
    default:
      return { text: '', media }
  }
}

function senderIdOf(event: FeishuEvent): string {
  const id = event.sender?.sender_id
  return id?.open_id ?? id?.union_id ?? id?.user_id ?? ''
}

function eventTime(envelope: FeishuEnvelope, fallback: number): number {
  const raw = envelope.header?.create_time
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Normalize a card button press into the text value the button was created with. */
function normalizeCard(envelope: FeishuEnvelope, accountId: string, now: number): NormalizedInbound | null {
  const event = envelope.event
  if (event === undefined) return null
  const chatId = event.context?.open_chat_id ?? event.open_chat_id
  const sender = event.operator?.open_id ?? event.operator?.union_id
  if (typeof chatId !== 'string' || chatId === '' || typeof sender !== 'string' || sender === '') return null
  const value = event.action?.value
  const text = typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && typeof (value as { value?: unknown })['value'] === 'string'
      ? ((value as { value: string })['value'])
      : ''
  if (text === '') return null
  const eventId = envelope.header?.event_id
  return {
    channel: CHANNEL_ID,
    accountId,
    conversationId: chatId,
    senderId: sender,
    text,
    media: [],
    group: false,
    at: eventTime(envelope, now),
    ...(typeof eventId === 'string' && eventId !== '' ? { platformMessageId: `card:${eventId}` } : {}),
    ...(typeof event.token === 'string' ? { cardCallbackToken: event.token, raw: { card: true, senderName: event.operator?.name ?? '' } } : { raw: { card: true } }),
  }
}

/**
 * The message this envelope describes, or null when it is not one for a person.
 */
export function normalizeInbound(envelope: FeishuEnvelope, accountId: string, now = Date.now()): NormalizedInbound | null {
  const eventType = envelope.header?.event_type
  if (eventType === 'card.action.trigger') return normalizeCard(envelope, accountId, now)
  if (eventType !== 'im.message.receive_v1') return null

  const event = envelope.event
  const message = event?.message
  if (event === undefined || message === undefined || message.message_id === undefined || message.chat_id === undefined) return null
  // An app/bot sender (including this bot's own echoed messages) never starts a turn.
  if (event.sender?.sender_type === 'app') return null
  const senderId = senderIdOf(event)
  if (senderId === '') return null

  const parsed = parseContent(message.message_type ?? '', message.content ?? '', message.message_id, message.mentions)
  if (parsed.text === '' && parsed.media.length === 0) return null

  return {
    channel: CHANNEL_ID,
    accountId,
    conversationId: message.chat_id,
    senderId,
    text: parsed.text,
    media: [],
    group: message.chat_type === 'group',
    at: eventTime(envelope, now),
    platformMessageId: `om:${message.message_id}`,
    ...(parsed.media.length === 0 ? {} : { mediaItems: parsed.media }),
  }
}
