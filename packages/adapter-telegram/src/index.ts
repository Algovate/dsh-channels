/**
 * The Telegram adapter.
 *
 * Same shape as the WeChat adapter and deliberately no bigger: it knows how to
 * poll updates, how to turn one into a normalized message, how to send text and
 * files, and how to phrase a numbered question. Turns, queues, gates, retries,
 * interactions and state all live in @rodin/dsh-channels — this file is the
 * evidence that the split holds, because it shares no line of WeChat code.
 *
 * @module @rodin/dsh-channels-telegram
 */
import fs from 'node:fs'
import path from 'node:path'

import type { AccountInfo, ChannelAdapter, InboundMedia, InboundMessage, InteractionReply, InteractionView, Outgoing, SendResult, Target } from '@rodin/dsh-channels'
import { MAX_TEXT_CHARS, TelegramTransport } from './transport.js'
import { CHANNEL_ID, mediaOf, normalizeInbound, type NormalizedInbound, type TelegramUpdate } from './normalize.js'

export { CHANNEL_ID, normalizeInbound } from './normalize.js'

export interface TelegramAdapterOptions {
  ctx?: unknown
  runtime?: { logger?: { info: (line: string) => void; warn: (line: string) => void }; markExpired?: (accountId: string, expired?: boolean) => void }
  stateRoot?: string
  config?: {
    token?: string
    apiBaseUrl?: string
    botId?: string
    pollTimeoutSeconds?: number
    mediaEnabled?: boolean
    maxInboundBytes?: number
    /** Injected in tests: the real fetch, so a poll can be stepped without a network. */
    fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; arrayBuffer?: () => Promise<ArrayBuffer> }>
  }
}

const MAX_INBOUND_MEDIA = 8
const DEFAULT_MAX_INBOUND_BYTES = 20 * 1024 * 1024

/** A file name that is safe to write and keeps the extension Telegram implied. */
function safeName(name: string, fallback: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return base === '' ? fallback : base
}

export async function createAdapter({ runtime, config = {}, stateRoot = '' }: TelegramAdapterOptions): Promise<ChannelAdapter> {
  const logger = runtime?.logger ?? { info: () => {}, warn: () => {} }
  const token = (config.token ?? '').trim()
  if (token === '') throw new Error('no Telegram bot token configured (adapterConfig["@rodin/dsh-channels-telegram"].token)')
  const botId = (config.botId ?? '').trim() || 'default'
  const mediaRoot = stateRoot === '' ? '' : path.join(stateRoot, 'media', 'inbound')
  const maxInboundBytes = Number.isFinite(config.maxInboundBytes) ? Number(config.maxInboundBytes) : DEFAULT_MAX_INBOUND_BYTES
  const mediaEnabled = config.mediaEnabled !== false && mediaRoot !== ''
  if (config.mediaEnabled !== false && mediaRoot === '') logger.warn('no state root: Telegram media will not be saved')

  const transport = new TelegramTransport({
    token,
    ...(config.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.apiBaseUrl }),
    ...(config.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: config.pollTimeoutSeconds }),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    logger,
  })
  const handlers = new Set<(message: InboundMessage) => void>()
  let loop: Promise<void> | undefined
  let stopped = false

  /** One attachment: fetch it, write it, and report where it went. */
  const saveMedia = async (item: NonNullable<NormalizedInbound['mediaItems']>[number]): Promise<InboundMedia | undefined> => {
    const downloaded = await transport.downloadFile(item.fileId)
    if ('error' in downloaded) {
      logger.warn(`telegram ${item.kind} not downloaded: ${downloaded.error}`)
      return undefined
    }
    if (downloaded.bytes.length > maxInboundBytes) {
      logger.warn(`telegram ${item.kind} skipped: ${downloaded.bytes.length} bytes over the cap`)
      return undefined
    }
    const extension = path.extname(item.fileName ?? downloaded.filePath) || (item.kind === 'image' ? '.jpg' : item.kind === 'video' ? '.mp4' : item.kind === 'voice' ? '.ogg' : '.bin')
    const directory = path.join(mediaRoot, safeName(botId, 'default'))
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${item.kind}${extension}`)
    fs.writeFileSync(file, downloaded.bytes, { mode: 0o600 })
    logger.info(`saved inbound ${item.kind} to ${file} (${downloaded.bytes.length} bytes)`)
    const media: InboundMedia = {
      kind: item.kind,
      path: file,
      mime: item.mime ?? 'application/octet-stream',
      bytes: downloaded.bytes.length,
      ...(item.fileName === undefined ? {} : { name: safeName(item.fileName, 'file') }),
    }
    return media
  }

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    const message = normalizeInbound(update, botId)
    if (message === null) return
    const items = (message.mediaItems ?? []).slice(0, MAX_INBOUND_MEDIA)
    if (items.length > 0 && mediaEnabled) {
      for (const item of items) {
        const saved = await saveMedia(item)
        if (saved !== undefined) message.media.push(saved)
      }
    }
    delete (message as { mediaItems?: unknown }).mediaItems
    for (const handler of handlers) handler(message)
  }

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '电报', en: 'Telegram' },
    capabilities: {
      text: true,
      media: { image: true, file: true, voice: false, video: true },
      // Telegram has stickers, a typing action and inline keyboards, but this
      // adapter only uses the last two indirectly: a sticker is not a message a
      // turn can answer, and the core's interactions are numbered text.
      stickers: false,
      typing: true,
      buttons: false,
      edit: false,
      maxTextChars: MAX_TEXT_CHARS,
    },
    accounts: {
      async list(): Promise<AccountInfo[]> {
        return [{ accountId: botId, label: botId, expired: false }]
      },
    },
    interactions: {
      format: 'numbered',
      render(view: InteractionView): Outgoing {
        const lines = [view.title]
        view.options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`))
        if (view.hint !== undefined && view.hint !== '') lines.push('', view.hint)
        return { text: lines.join('\n'), kind: 'question' }
      },
      parse(reply: string, view: InteractionView): InteractionReply | null {
        const normalized = reply.trim().replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
        if (!/^\d{1,2}$/.test(normalized)) return null
        const index = Number(normalized) - 1
        const option = view.options[index]
        return option === undefined ? null : { value: option.id }
      },
    },
    async start(): Promise<void> {
      logger.info(`telegram adapter polling bot ${botId}`)
      loop = (async () => {
        while (!stopped) {
          try {
            const updates = await transport.pollOnce()
            for (const update of updates) await handleUpdate(update)
          } catch (error) {
            logger.warn(`telegram poll failed: ${String((error as Error)?.message ?? error)}`)
            // A failed poll backs off; a rejecting server must not be hammered.
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
        }
      })()
    },
    async stop(): Promise<void> {
      stopped = true
      transport.stop()
      await loop?.catch(() => {})
      loop = undefined
    },
    onInbound(handler: (message: InboundMessage) => void): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      const media = outgoing.media ?? []
      if (media.length > 0) {
        let last: SendResult = { ok: false, code: 'empty' }
        for (const [index, item] of media.entries()) {
          const kind = item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'file'
          last = await transport.sendFile(target.conversationId, item.path, index === 0 ? outgoing.text ?? '' : '', kind)
        }
        return last
      }
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      return transport.sendText(target.conversationId, text)
    },
    async typing(target: Target): Promise<void> {
      await transport.typing(target.conversationId)
    },
  }
  return adapter
}

export { mediaOf }
