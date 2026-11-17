/**
 * The contracts every channel adapter implements.
 *
 * An adapter only translates: it knows its platform's wire format and nothing
 * about turns, interactions, sessions or storage. The core knows the opposite.
 * Keeping that line sharp is what lets a second channel be a few hundred lines
 * instead of a copy of the first one.
 *
 * @module @derekluo/dsh-channels/types
 */

/** Stable channel id. Also the `source.kind` of a message from this channel. */
export type ChannelId = string

export interface Target {
  channel: ChannelId
  accountId: string
  conversationId: string
}

export interface InboundMedia {
  kind: 'image' | 'file' | 'voice' | 'video'
  path: string
  mime: string
  bytes: number
  /** Original file name when the platform knows one. */
  name?: string
  /** Present only for voice notes that were actually transcribed. */
  transcript?: string
  /** Present only for documents whose text could be extracted. */
  text?: string
}

export interface InboundMessage extends Target {
  senderId: string
  /** The person's own words. Injected context never travels here. */
  text: string
  media: InboundMedia[]
  /** True when the platform says this conversation is a group, not a 1:1 chat. */
  group: boolean
  at: number
  /** A stable provider ID, unique within this conversation when available. */
  platformMessageId?: string
  /** Platform-private structure, for adapter diagnostics only. */
  raw?: unknown
}

export interface OutgoingMedia {
  kind: 'image' | 'file' | 'video' | 'voice'
  path: string
  mime?: string
  name?: string
}

export interface Outgoing {
  text?: string
  /** Soft limit the core applies per channel capability. */
  bubbles?: { maxChars: number; gapMs: number }
  media?: OutgoingMedia[]
  kind: 'reply' | 'notice' | 'question'
}

/**
 * Three states, because "the platform accepted it" is not "the person got it".
 * iLink answers `ret: 0` without a `message_id` for some sends; a two-state
 * result would have to call that either success or failure and be wrong.
 */
export type SendResult =
  | { ok: true; messageId: string; unconfirmed?: false }
  | { ok: true; unconfirmed: true; messageId?: string }
  | { ok: false; code: string; detail?: string; retryAfterMs?: number }

export interface Capabilities {
  text: boolean
  media: { image: boolean; file: boolean; voice: boolean; video: boolean }
  stickers: boolean
  typing: boolean
  buttons: boolean
  edit: boolean
  /** 0 means "no limit the core needs to enforce". */
  maxTextChars: number
}

export interface InteractionView {
  id: string
  kind: 'question' | 'approval'
  conversation: Target
  title: string
  options: { id: string; label: string }[]
  hint?: string
  expiresAt: number
}

export type InteractionReply = { value: string }

export interface AccountInfo {
  accountId: string
  label?: string
  /** True once the platform has rejected the credential; the card says "log in again". */
  expired: boolean
}

export interface AccountSurface {
  list(): Promise<AccountInfo[]>
  /** Marks one account expired after the platform rejected its credential. */
  markExpired?(accountId: string, expired: boolean): void
}

export interface ChannelAdapter {
  readonly id: ChannelId
  readonly label: { zh: string; en: string }
  readonly capabilities: Capabilities
  readonly accounts: AccountSurface
  readonly interactions: {
    format: 'numbered' | 'native'
    render(view: InteractionView): Outgoing
    parse(reply: string, view: InteractionView): InteractionReply | null
  }
  start(): Promise<void>
  stop(): Promise<void>
  onInbound(handler: (message: InboundMessage) => void): () => void
  send(target: Target, outgoing: Outgoing): Promise<SendResult>
  typing?(target: Target): Promise<void>
}

/** Core hooks available to an adapter before it delivers an inbound message. */
export interface AdapterRuntime {
  logger?: { info: (line: string) => void; warn: (line: string) => void }
  markExpired?(accountId: string, expired?: boolean): void
  /** Run before downloading attachments, then deliver the same message object. */
  canReceive?(message: InboundMessage, hasAttachments: boolean, legacyAccountId?: string): boolean
  /** Release a preflight reservation if the message never reaches core. Safe after delivery. */
  cancelReceive?(message: InboundMessage): void
}

/** What an adapter package exports. */
export interface AdapterModule {
  createAdapter(options: {
    ctx: unknown
    runtime: AdapterRuntime
    stateRoot?: string
    config: Record<string, unknown>
  }): ChannelAdapter | Promise<ChannelAdapter>
}
