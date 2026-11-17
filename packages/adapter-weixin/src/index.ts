/**
 * The Weixin adapter: iLink in, one normalized message per person-message out.
 *
 * It knows the platform and nothing else. Everything about turns, queues,
 * interactions and storage lives in the core, which is what makes a second
 * channel a few hundred lines instead of a copy of this file.
 *
 * @module @rodin/dsh-channels-weixin
 */
import { listIndexedWeixinAccountIds } from '../vendor/openclaw-weixin/auth/accounts.js'
import type { AccountInfo, ChannelAdapter, InboundMessage, InteractionReply, InteractionView, Outgoing, SendResult, Target } from '@rodin/dsh-channels'
import { normalizeInbound, type RawMessage } from './normalize.js'
import { WeixinTransport, readAccount } from './transport.js'

export const CHANNEL_ID = 'weixin'

export interface WeixinAdapterOptions {
  ctx?: unknown
  runtime?: { logger?: { info: (line: string) => void; warn: (line: string) => void }; markExpired?: (accountId: string, expired?: boolean) => void }
  stateRoot?: string
  config?: { accountId?: string; longPollTimeoutMs?: number; stateDir?: string }
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
      for (const handler of handlers) handler(message)
    },
  })

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '微信', en: 'WeChat' },
    capabilities: {
      text: true,
      media: { image: false, file: false, voice: false, video: false },
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
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      return transport.sendText(target.conversationId, text)
    },
  }

  return adapter
}
