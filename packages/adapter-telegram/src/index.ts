/**
 * The Telegram adapter.
 *
 * Same shape as the WeChat adapter and deliberately no bigger: it knows how to
 * poll updates, how to turn one into a normalized message, how to send text and
 * files, and how to phrase a numbered question. Turns, queues, gates, retries,
 * interactions and state all live in @derekluo/dsh-channels — this file is the
 * evidence that the split holds, because it shares no line of WeChat code.
 *
 * @module @derekluo/dsh-channels-telegram
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { AccountInfo, AdapterRuntime, ChannelAdapter, InboundMedia, InboundMessage, Outgoing, SendResult, Target } from '@derekluo/dsh-channels'
import { DEFAULT_API_BASE, MAX_TEXT_CHARS, TelegramTransport, type FetchLike } from './transport.js'
import { CHANNEL_ID, mediaOf, normalizeInbound, type NormalizedInbound, type TelegramUpdate } from './normalize.js'

export { CHANNEL_ID, normalizeInbound } from './normalize.js'

export interface TelegramAdapterOptions {
  ctx?: unknown
  runtime?: AdapterRuntime
  stateRoot?: string
  config?: {
    token?: string
    apiBaseUrl?: string
    /** Optional display label; the account ID comes from the bot token. */
    botId?: string
    pollTimeoutSeconds?: number
    mediaEnabled?: boolean
    maxInboundBytes?: number
    /** Injected in tests: the real fetch, so a poll can be stepped without a network. */
    fetchImpl?: FetchLike
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
  if (token === '') throw new Error('no Telegram bot token configured (adapterConfig["@derekluo/dsh-channels-telegram"].token)')
  const apiBase = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const telegramId = /^([1-9]\d*):[\w-]+$/.exec(token)?.[1]
  if (telegramId === undefined && apiBase === DEFAULT_API_BASE) {
    throw new Error('invalid Telegram bot token: expected a numeric bot ID followed by a colon and secret')
  }
  const accountId = apiBase === DEFAULT_API_BASE
    ? `bot:${telegramId}`
    : `custom:${createHash('sha256').update(apiBase).update('\0').update(telegramId ?? token).digest('hex')}`
  const previousLabel = (config.botId ?? '').trim()
  const legacyAccountId = previousLabel || 'default'
  const label = previousLabel || telegramId || accountId
  const mediaRoot = stateRoot === '' ? '' : path.join(stateRoot, 'media', 'inbound')
  const maxInboundBytes = Number.isFinite(config.maxInboundBytes) ? Math.max(0, Number(config.maxInboundBytes)) : DEFAULT_MAX_INBOUND_BYTES
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

  /** One attachment: fetch it, write it, and report where it went. */
  const saveMedia = async (item: NonNullable<NormalizedInbound['mediaItems']>[number]): Promise<InboundMedia | undefined> => {
    if (item.bytes !== undefined && item.bytes > maxInboundBytes) {
      logger.warn(`telegram ${item.kind} skipped: ${item.bytes} bytes over the cap`)
      return undefined
    }
    const downloaded = await transport.downloadFile(item.fileId, maxInboundBytes)
    if ('error' in downloaded) {
      logger.warn(`telegram ${item.kind} not downloaded: ${downloaded.error}`)
      return undefined
    }
    const extension = path.extname(item.fileName ?? downloaded.filePath) || (item.kind === 'image' ? '.jpg' : item.kind === 'video' ? '.mp4' : item.kind === 'voice' ? '.ogg' : '.bin')
    const directory = path.join(mediaRoot, safeName(accountId, 'telegram'))
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
    const message = normalizeInbound(update, accountId)
    if (message === null) return
    const items = (message.mediaItems ?? []).slice(0, MAX_INBOUND_MEDIA)
    delete message.mediaItems
    if (runtime?.canReceive?.(message, items.length > 0, legacyAccountId) === false) return
    try {
      if (items.length > 0 && mediaEnabled) {
        for (const item of items) {
          const saved = await saveMedia(item)
          if (transport.signal.aborted) return
          if (saved !== undefined) message.media.push(saved)
        }
      }
      for (const handler of handlers) handler(message)
    } finally {
      runtime?.cancelReceive?.(message)
    }
  }

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '电报', en: 'Telegram' },
    capabilities: {
      media: { image: true, file: true, voice: false, video: true },
      maxTextChars: MAX_TEXT_CHARS,
    },
    accounts: {
      async list(): Promise<AccountInfo[]> {
        return [{ accountId, label, expired: false }]
      },
    },

    async start(): Promise<void> {
      if (loop !== undefined) return
      transport.start()
      logger.info(`telegram adapter polling bot ${accountId}`)
      loop = (async () => {
        while (!transport.signal.aborted) {
          let updates: TelegramUpdate[]
          try {
            updates = await transport.pollOnce()
          } catch (error) {
            if (transport.signal.aborted) break
            logger.warn(`telegram poll failed: ${String((error as Error)?.message ?? error)}`)
            await delay(3000, undefined, { signal: transport.signal }).catch(() => {})
            continue
          }
          for (const update of updates) {
            if (transport.signal.aborted) break
            try {
              await handleUpdate(update)
            } catch (error) {
              logger.warn(`telegram update failed: ${String((error as Error)?.message ?? error)}`)
            }
          }
        }
      })()
    },
    async stop(): Promise<void> {
      transport.stop()
      await loop?.catch(() => {})
      loop = undefined
    },
    onInbound(handler: (message: InboundMessage) => void): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      if (target.channel !== CHANNEL_ID || target.accountId !== accountId) return { ok: false, code: 'account-mismatch' }
      const media = outgoing.media ?? []
      if (media.length > 0) {
        let last: SendResult = { ok: false, code: 'empty' }
        for (const [index, item] of media.entries()) {
          const kind = item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'file'
          last = await transport.sendFile(target.conversationId, item.path, index === 0 ? outgoing.text ?? '' : '', kind)
          if (!last.ok) return last
        }
        return last
      }
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      return transport.sendText(target.conversationId, text)
    },
    async typing(target: Target): Promise<void> {
      if (target.channel !== CHANNEL_ID || target.accountId !== accountId) return
      await transport.typing(target.conversationId)
    },
  }
  return adapter
}

export { mediaOf }
