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
  /** Descriptions of attachments omitted during download or decoding. */
  attachmentErrors?: string[]
  /** The person's own words. Injected context never travels here. */
  text: string
  media: InboundMedia[]
  /** True when the platform says this conversation is a group, not a 1:1 chat. */
  group: boolean
  at: number
  /** A stable provider ID, unique within this conversation when available. */
  platformMessageId?: string
  /** Platform-private context, also persisted for queued-message recovery. */
  raw?: unknown
}

export interface OutgoingMedia {
  kind: 'image' | 'file' | 'video' | 'voice'
  path: string
  mime?: string
  name?: string
}

export interface OutgoingAction {
  label: string
  /** Text this action sends back when the platform supports native buttons. */
  value: string
}

export interface Outgoing {
  text?: string
  media?: OutgoingMedia[]
  /** Native buttons; adapters without `capabilities.actions` receive text only. */
  actions?: OutgoingAction[]
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
  media: { image: boolean; file: boolean; voice: boolean; video: boolean }
  /** Native inline actions for interaction prompts. */
  actions?: boolean
  /** The adapter can edit a previously sent message in place. */
  edit?: boolean
  /** 0 means "no limit the core needs to enforce". */
  maxTextChars: number
}

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

/** The core's durable ingress boundary; a driver offers one message at a time. */
export interface IngressSink {
  /** Resolve after durable acceptance/refusal; DSH_INBOUND_RETRY means retain and retry the provider update. */
  offer(message: InboundMessage, options?: { priority?: boolean }): Promise<void>
}

export interface ChannelAdapter {
  readonly id: ChannelId
  readonly label: { zh: string; en: string }
  readonly capabilities: Capabilities
  readonly accounts: AccountSurface
  /** The core owns durable handoff, ordering and retry. */
  startWithSink(sink: IngressSink): Promise<void>
  stop(): Promise<void>
  /** Restore platform-private routing context before replaying a persisted input. */
  restoreInbound?(message: InboundMessage): void
  send(target: Target, outgoing: Outgoing): Promise<SendResult>
  /** Edit one previously sent message; text only, no media. */
  edit?(target: Target, messageId: string, outgoing: Outgoing): Promise<SendResult>
  typing?(target: Target): Promise<void>
}

/** Core hooks available to an adapter before it delivers an inbound message. */
export interface AdapterRuntime {
  logger?: { info: (line: string) => void; warn: (line: string) => void }
  markExpired?(accountId: string, expired?: boolean): void
  /** Priority text may bypass media enrichment; this does not authorize delivery. */
  canBypassInbound?(message: InboundMessage): boolean
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
