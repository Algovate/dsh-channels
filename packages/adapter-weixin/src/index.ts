/**
 * The Weixin adapter: iLink in, one normalized message per person-message out.
 *
 * It knows the platform and nothing else. Everything about turns, queues,
 * interactions and storage lives in the core, which is what makes a second
 * channel a few hundred lines instead of a copy of this file.
 *
 * @module @rodin/dsh-channels-weixin
 */
import path from 'node:path'

import { listIndexedWeixinAccountIds } from '../vendor/openclaw-weixin/auth/accounts.js'
import type { AccountInfo, ChannelAdapter, InboundMessage, InteractionReply, InteractionView, Outgoing, SendResult, Target } from '@rodin/dsh-channels'
import { mediaItemsOf, normalizeInbound, type RawMediaItem, type RawMessage } from './normalize.js'
import { MAX_INBOUND_MEDIA, saveInboundItem } from './media.js'
import { WeixinTransport, readAccount } from './transport.js'

export const CHANNEL_ID = 'weixin'

export interface WeixinAdapterOptions {
  ctx?: unknown
  runtime?: { logger?: { info: (line: string) => void; warn: (line: string) => void }; markExpired?: (accountId: string, expired?: boolean) => void }
  stateRoot?: string
  config?: { accountId?: string; longPollTimeoutMs?: number; stateDir?: string; cdnBaseUrl?: string; mediaEnabled?: boolean }
}

export async function createAdapter({ runtime, config = {}, stateRoot }: WeixinAdapterOptions): Promise<ChannelAdapter> {
  const logger = runtime?.logger ?? { info: () => {}, warn: () => {} }
  // The vendored transport resolves its state dir from the environment on every
  // call, so one assignment before the first read is enough. It is also why two
  // channel plugins must never be mounted together: both would own this variable.
  const stateDir = (config.stateDir ?? stateRoot ?? '').trim()
  if (stateDir !== '') process.env['OPENCLAW_STATE_DIR'] = stateDir
  const accountIds = listIndexedWeixinAccountIds() as string[]
  const accountId = (config.accountId ?? accountIds[0] ?? '').trim()
  if (accountId === '') throw new Error('no Weixin account is saved; run the login flow or the import command first')

  const account = readAccount(accountId)
  if (account === undefined) throw new Error(`account '${accountId}' has no token; log in again`)

  const expired = new Set<string>()
  const handlers = new Set<(message: InboundMessage) => void>()
  const transport = new WeixinTransport({
    accountId,
    baseUrl: account.baseUrl,
    token: account.token,
    logger,
    longPollTimeoutMs: config.longPollTimeoutMs,
    onSessionRejected: (isExpired) => {
      if (!isExpired) return
      expired.add(accountId)
      runtime?.markExpired?.(accountId, true)
      logger.warn(`account ${accountId} was rejected by the server; log in again`)
    },
    onMessage: (raw: RawMessage) => {
      const message = normalizeInbound(raw, accountId)
      if (message === null) return
      if (message.contextToken !== '') transport.rememberContextToken(message.conversationId, message.contextToken)
      // The download is async; the poll loop must not wait on it (a 20MB video
      // would stall every other conversation), so the handlers run after it.
      void attachMedia(message)
        .catch((error: unknown) => logger.warn(`inbound media failed: ${String((error as Error)?.message ?? error)}`))
        .then(() => {
          for (const handler of handlers) handler(message)
        })
    },
  })

  const stateRootUsed = stateDir !== '' ? stateDir : (process.env['OPENCLAW_STATE_DIR'] ?? '')
  // Without a state root there is nowhere to put a photo; say so once and keep
  // text working instead of writing into whatever the cwd happens to be.
  const mediaEnabled = config.mediaEnabled !== false && stateRootUsed !== ''
  if (config.mediaEnabled !== false && stateRootUsed === '') logger.warn('no state root: inbound media will not be saved')
  const mediaRoot = stateRootUsed === '' ? '' : path.join(stateRootUsed, 'media', 'inbound')
  const cdnBaseUrl = config.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c'

  /** Fetch the attachments of one message, in parallel, without failing the message. */
  const attachMedia = async (message: ReturnType<typeof normalizeInbound>): Promise<void> => {
    if (message === null || mediaEnabled !== true) return
    const items: RawMediaItem[] = mediaItemsOf(message).slice(0, MAX_INBOUND_MEDIA)
    if (items.length === 0) return
    const saved = await Promise.all(
      items.map((item) =>
        saveInboundItem(item, { accountId, mediaRoot, cdnBaseUrl, messageId: message.at.toString(36), logger }).catch((error: unknown) => ({
          ok: false as const,
          kind: 'file' as const,
          reason: String((error as Error)?.message ?? error),
        })),
      ),
    )
    for (const result of saved) {
      if (result.ok) message.media.push(result.media)
      else logger.warn(`inbound ${result.kind} not saved: ${result.reason}`)
    }
  }

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '微信', en: 'WeChat' },
    capabilities: {
      text: true,
      // Voice outbound stays false on purpose: the server accepts it and never
      // delivers it, so audio goes out as a file.
      media: { image: true, file: true, voice: false, video: true },
      stickers: false,
      typing: false,
      buttons: false,
      edit: false,
      maxTextChars: 600,
    },
    accounts: {
      async list(): Promise<AccountInfo[]> {
        return (listIndexedWeixinAccountIds() as string[]).map((id) => ({
          accountId: id,
          expired: expired.has(id),
        }))
      },
      markExpired(id: string, value = true): void {
        if (value) expired.add(id)
        else expired.delete(id)
      },
    },
    interactions: {
      // WeChat has no buttons worth relying on: numbered text is the contract.
      format: 'numbered',
      render(view: InteractionView): Outgoing {
        const lines = [view.title, '']
        view.options.forEach((option, index) => {
          lines.push(`${index + 1}. ${option.label}`)
        })
        if (view.hint !== undefined && view.hint !== '') lines.push('', view.hint)
        const minutes = Math.max(1, Math.round((view.expiresAt - Date.now()) / 60_000))
        lines.push('', `（回复序号即可，${minutes} 分钟内有效）`)
        return { text: lines.join('\n'), kind: 'question' }
      },
      parse(reply: string, view: InteractionView): InteractionReply | null {
        const match = /^\s*(\d{1,2})\s*[.、。]?\s*$/.exec(reply)
        if (match === null) return null
        const option = view.options[Number(match[1]) - 1]
        return option === undefined ? null : { value: option.id }
      },
    },
    async start(): Promise<void> {
      transport.start()
      logger.info(`weixin adapter polling account ${accountId}`)
    },
    async stop(): Promise<void> {
      await transport.stop()
    },
    onInbound(handler: (message: InboundMessage) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      const media = outgoing.media ?? []
      if (media.length > 0) {
        // One call per attachment; the caption rides on the first one, which is
        // how WeChat shows "text above a picture".
        let last: SendResult = { ok: false, code: 'empty' }
        for (const [index, item] of media.entries()) {
          last = await transport.sendMedia(target.conversationId, item.path, index === 0 ? outgoing.text ?? '' : '')
        }
        return last
      }
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      return transport.sendText(target.conversationId, text)
    },
  }

  return adapter
}
