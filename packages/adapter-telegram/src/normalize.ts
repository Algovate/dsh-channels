/**
 * Telegram update → one normalized inbound message (or none).
 *
 * Telegram is friendlier than iLink in the ways that matter here: every update
 * carries an integer id, `from.id` is stable, and a message that is not for us
 * (a bot, a channel post, an edit) is easy to recognise. The adapter still
 * refuses those explicitly rather than passing them on: the core's job is
 * turning a person's message into a turn, and a system message is not one.
 *
 * @module @rodin/dsh-channels-telegram/normalize
 */
import type { InboundMedia, InboundMessage } from '@rodin/dsh-channels'

export const CHANNEL_ID = 'telegram'

/** One attachment as Telegram named it, before it is downloaded. */
export interface RawMedia {
  kind: InboundMedia['kind']
  fileId: string
  fileName?: string
  mime?: string
  bytes?: number
}

export interface TelegramUser {
  id?: number
  is_bot?: boolean
  username?: string
  first_name?: string
}

export interface TelegramChat {
  id?: number
  type?: string
  title?: string
  username?: string
  first_name?: string
}

export interface TelegramMessage {
  message_id?: number
  date?: number
  text?: string
  caption?: string
  from?: TelegramUser
  chat?: TelegramChat
  photo?: Array<{ file_id?: string; file_size?: number; width?: number; height?: number }>
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id?: string; mime_type?: string; file_size?: number }
  audio?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number }
  video?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number }
  sticker?: unknown
  edit_date?: number
}

export interface TelegramUpdate {
  update_id?: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
}

export interface NormalizedInbound extends InboundMessage {
  /** The attachment descriptors this message carries, if any. */
  mediaItems?: RawMedia[]
}

/** The user's display name, for a row that has no id to show. */
export function displayName(user: TelegramUser | undefined, chat: TelegramChat | undefined): string {
  const name = user?.username ?? user?.first_name ?? chat?.username ?? chat?.title
  return typeof name === 'string' && name !== '' ? name : ''
}

/**
 * Describe the attachments of one message.
 *
 * A photo arrives as several sizes of the same file; only the largest is worth
 * downloading — the smaller ones are thumbnails the chat client invented.
 */
export function mediaOf(message: TelegramMessage): RawMedia[] {
  const media: RawMedia[] = []
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = [...message.photo]
      .filter((photo) => typeof photo?.file_id === 'string' && photo.file_id !== '')
      .sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0]
    if (largest?.file_id !== undefined) {
      media.push({ kind: 'image', fileId: largest.file_id, mime: 'image/jpeg', ...(largest.file_size === undefined ? {} : { bytes: largest.file_size }) })
    }
  }
  if (typeof message.document?.file_id === 'string') {
    media.push({
      kind: 'file',
      fileId: message.document.file_id,
      ...(message.document.file_name === undefined ? {} : { fileName: message.document.file_name }),
      ...(message.document.mime_type === undefined ? {} : { mime: message.document.mime_type }),
      ...(message.document.file_size === undefined ? {} : { bytes: message.document.file_size }),
    })
  }
  if (typeof message.voice?.file_id === 'string') {
    media.push({
      kind: 'voice',
      fileId: message.voice.file_id,
      mime: message.voice.mime_type ?? 'audio/ogg',
      ...(message.voice.file_size === undefined ? {} : { bytes: message.voice.file_size }),
    })
  }
  if (typeof message.audio?.file_id === 'string') {
    media.push({
      kind: 'voice',
      fileId: message.audio.file_id,
      ...(message.audio.file_name === undefined ? {} : { fileName: message.audio.file_name }),
      mime: message.audio.mime_type ?? 'audio/mpeg',
      ...(message.audio.file_size === undefined ? {} : { bytes: message.audio.file_size }),
    })
  }
  if (typeof message.video?.file_id === 'string') {
    media.push({
      kind: 'video',
      fileId: message.video.file_id,
      ...(message.video.file_name === undefined ? {} : { fileName: message.video.file_name }),
      mime: message.video.mime_type ?? 'video/mp4',
      ...(message.video.file_size === undefined ? {} : { bytes: message.video.file_size }),
    })
  }
  return media
}

/**
 * The message this update describes, or null when it is not one for a person.
 *
 * `edited_message` is refused: an edit is not a new input — turning it into one
 * would make the agent answer the same thought twice. `channel_post` is a
 * broadcast, and a bot's own message must never loop back into a turn.
 */
export function normalizeInbound(update: TelegramUpdate, accountId: string, now = Date.now()): NormalizedInbound | null {
  const message = update?.message
  if (message === undefined || message === null) return null
  if (message.edit_date !== undefined) return null
  if (message.from?.is_bot === true) return null

  const chatId = message.chat?.id
  const senderId = message.from?.id
  if (typeof chatId !== 'number' || typeof senderId !== 'number') return null

  const text = typeof message.text === 'string' ? message.text.trim() : ''
  const mediaItems = mediaOf(message)
  // A sticker or an unsupported service message carries neither text nor media.
  if (text === '' && mediaItems.length === 0) return null

  const caption = typeof message.caption === 'string' ? message.caption.trim() : ''
  const group = message.chat?.type === 'group' || message.chat?.type === 'supergroup'
  const name = displayName(message.from, message.chat)
  const seconds = typeof message.date === 'number' ? message.date * 1000 : now
  return {
    channel: CHANNEL_ID,
    accountId,
    conversationId: String(chatId),
    senderId: String(senderId),
    text: text !== '' ? text : caption,
    media: [],
    group,
    at: seconds,
    ...(name === '' ? {} : { raw: { senderName: name } }),
    ...(mediaItems.length === 0 ? {} : { mediaItems }),
  }
}
