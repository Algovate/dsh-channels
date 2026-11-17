/**
 * One raw iLink message → one normalized inbound message.
 *
 * Deliberately total: anything surprising returns `null` (the loop drops it)
 * rather than throwing, and the plugin's own echoes are dropped first — a bot
 * that answers itself is the classic infinite loop.
 *
 * Attachment descriptors are retained here so the adapter can authorize the
 * sender before downloading media.
 *
 * @module @rodin/dsh-channels-weixin/normalize
 */
import { MessageItemType, MessageState, MessageType } from '../vendor/openclaw-weixin/api/types.js'
import type { InboundMessage } from '@rodin/dsh-channels'

const TEXT_ITEM = MessageItemType.TEXT

function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/** Fields of a raw iLink `msgs[]` entry that this module reads. */
export interface RawMessage {
  message_type?: number
  message_state?: number
  from_user_id?: string
  group_id?: string
  message_id?: string | number
  client_id?: string
  create_time_ms?: number
  context_token?: string
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>
}

export interface NormalizedInbound extends InboundMessage {
  /** iLink routes a reply by this token; the adapter keeps the latest per conversation. */
  contextToken: string
}

/** A media item as iLink sent it, before it is downloaded. */
export interface RawMediaItem {
  type?: number
  image_item?: unknown
  voice_item?: unknown
  file_item?: { file_name?: string }
  video_item?: unknown
}

export function normalizeInbound(raw: RawMessage, accountId: string): NormalizedInbound | null {
  if (raw === null || typeof raw !== 'object') return null
  // Our own outbound echoes come back through getUpdates.
  if (raw.message_type === MessageType.BOT) return null
  if (raw.message_state !== undefined && raw.message_state !== MessageState.FINISH && raw.message_state !== MessageState.NEW) return null

  const senderId = typeof raw.from_user_id === 'string' ? raw.from_user_id : ''
  if (senderId === '') return null
  // A 1:1 message carries `group_id: ""`; `??` alone would make the conversation
  // id empty and every reply would be addressed to nobody.
  const conversationId = blankToUndefined(raw.group_id) ?? senderId
  const group = conversationId !== senderId

  const items = Array.isArray(raw.item_list) ? raw.item_list : []
  const texts: string[] = []
  const media: RawMediaItem[] = []
  for (const item of items) {
    if (item?.type === TEXT_ITEM && typeof item.text_item?.text === 'string' && item.text_item.text !== '') {
      texts.push(item.text_item.text)
    } else if (item !== undefined && item !== null) {
      media.push(item as RawMediaItem)
    }
  }
  const text = texts.join('\n').trim()
  // A media-only message is still a message: the attachment is the message.
  if (text === '' && media.length === 0) return null

  const id = raw.message_id
  const validServerId = typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && id.length <= 256 && id !== '' && id !== '0'
  const clientId = blankToUndefined(raw.client_id)
  const platformMessageId = validServerId ? `message:${id}` : clientId !== undefined && clientId.length <= 256 ? `client:${clientId}` : undefined

  return {
    channel: 'weixin',
    accountId,
    conversationId,
    senderId,
    text,
    media: [],
    group,
    at: typeof raw.create_time_ms === 'number' ? raw.create_time_ms : Date.now(),
    ...(platformMessageId === undefined ? {} : { platformMessageId }),
    contextToken: typeof raw.context_token === 'string' ? raw.context_token : '',
    ...(media.length === 0 ? {} : { raw: { mediaItems: media } }),
  }
}

/** The media items to fetch for one normalized message. */
export function mediaItemsOf(message: NormalizedInbound): RawMediaItem[] {
  const raw = message.raw as { mediaItems?: RawMediaItem[] } | undefined
  return Array.isArray(raw?.mediaItems) ? raw.mediaItems : []
}
