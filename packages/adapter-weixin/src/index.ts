/**
 * The Weixin adapter: iLink in, one normalized message per person-message out.
 *
 * It knows the platform and nothing else. Everything about turns, queues,
 * interactions and storage lives in the core, which is what makes a second
 * channel a few hundred lines instead of a copy of this file.
 *
 * @module @derekluo/dsh-channels-weixin
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CDN_BASE_URL, listIndexedWeixinAccountIds } from '../vendor/openclaw-weixin/auth/accounts.js'
import type { AccountInfo, AdapterRuntime, ChannelAdapter, InboundMessage, Outgoing, SendResult, Target } from '@derekluo/dsh-channels'
import { mediaItemsOf, normalizeInbound, type NormalizedInbound, type RawMediaItem, type RawMessage } from './normalize.js'
import { MAX_INBOUND_MEDIA, MAX_INBOUND_MESSAGE_BYTES, saveInboundItem } from './media.js'
import { AsrBridge } from './asr.js'
import { WeixinTransport, readAccount } from './transport.js'

export const CHANNEL_ID = 'weixin'

/** Nearest ancestor that looks like a package root (holds a package.json). */
export function packageRoot(from: string): string {
  let dir = path.resolve(from)
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(from)
}

export interface WeixinAdapterOptions {
  ctx?: unknown
  runtime?: AdapterRuntime
  stateRoot?: string
  config?: {
    accountId?: string
    longPollTimeoutMs?: number
    stateDir?: string
    cdnBaseUrl?: string
    mediaEnabled?: boolean
    asrEnabled?: boolean
    asrCommand?: string
    asrModelDir?: string
    asrLanguage?: string
  }
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
  const inbox = new Map<string, Promise<void>>()
  const contextOrder = new Map<string, number>()
  let receivedOrder = 0
  const cdnBaseUrl = (config.cdnBaseUrl ?? CDN_BASE_URL).replace(/\/+$/, '')
  let inbound: AbortController | undefined
  let asr: AsrBridge | undefined
  let stopping: Promise<void> | undefined
  const transport = new WeixinTransport({
    accountId,
    baseUrl: account.baseUrl,
    token: account.token,
    logger,
    longPollTimeoutMs: config.longPollTimeoutMs,
    cdnBaseUrl,
    onSessionRejected: (isExpired) => {
      if (!isExpired) return
      expired.add(accountId)
      runtime?.markExpired?.(accountId, true)
      logger.warn(`account ${accountId} was rejected by the server; log in again`)
    },
    onMessage: (raw: RawMessage) => {
      const signal = inbound?.signal
      if (signal === undefined || signal.aborted) return
      const message = normalizeInbound(raw, accountId)
      if (message === null) return
      const items = mediaItemsOf(message)
      message.raw = { contextToken: message.contextToken }
      const { conversationId, contextToken } = message
      const order = ++receivedOrder
      // Slow attachments must not make later messages pass earlier ones in the same chat.
      const deliver = async () => {
        if (signal.aborted || runtime?.canReceive?.(message, items.length > 0) === false) return
        try {
          if (contextToken !== '' && order > (contextOrder.get(conversationId) ?? -1)) {
            contextOrder.set(conversationId, order)
            transport.rememberContextToken(conversationId, contextToken)
          }
          await attachMedia(message, items, signal)
          if (signal.aborted) return
          for (const handler of handlers) handler(message)
        } finally {
          runtime?.cancelReceive?.(message)
        }
      }
      if (items.length === 0 && runtime?.canBypassInbound?.(message) === true) return deliver()
      const queued = (inbox.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(deliver)
      inbox.set(conversationId, queued)
      return queued.finally(() => {
        if (inbox.get(conversationId) === queued) inbox.delete(conversationId)
      })
    },
  })

  const stateRootUsed = stateDir !== '' ? stateDir : (process.env['OPENCLAW_STATE_DIR'] ?? '')
  // Without a state root there is nowhere to put a photo; say so once and keep
  // text working instead of writing into whatever the cwd happens to be.
  const mediaEnabled = config.mediaEnabled !== false && stateRootUsed !== ''
  if (config.mediaEnabled !== false && stateRootUsed === '') logger.warn('no state root: inbound media will not be saved')
  const mediaRoot = stateRootUsed === '' ? '' : path.join(stateRootUsed, 'media', 'inbound')

  // Voice notes become text when the Python bridge and a model are available;
  // otherwise the WAV path travels and the note says it could not be listened
  // to. The bridge is optional on purpose (python3 + whisper is not something a
  // channel plugin may require).
  const createAsr = () =>
    (config.asrEnabled ?? true) && stateRootUsed !== ''
      ? new AsrBridge({
          // `import.meta.url` is `dist/src/index.js` in the published package and
          // `src/index.ts` in a checkout, so the package root is found by walking
          // up to the manifest instead of guessing `..` twice.
          scriptPath: path.join(packageRoot(path.dirname(fileURLToPath(import.meta.url))), 'bin', 'asr-bridge.py'),
          modelDir: config.asrModelDir ?? path.join(stateRootUsed, 'asr-models'),
          ...(config.asrCommand === undefined ? {} : { command: config.asrCommand }),
          ...(config.asrLanguage === undefined ? {} : { language: config.asrLanguage }),
          logger,
        })
      : undefined
  /** Fetch attachments sequentially within one message byte budget; other chats share two slots. */
  const attachMedia = async (message: NormalizedInbound, items: RawMediaItem[], signal: AbortSignal): Promise<void> => {
    if (items.length === 0) return
    message.attachmentErrors = []
    if (!mediaEnabled) { message.attachmentErrors.push('附件接收未启用，请发送文字。'); return }
    if (items.length > MAX_INBOUND_MEDIA) message.attachmentErrors.push('附件数量超过上限，其余附件未接收。')
    let remaining = MAX_INBOUND_MESSAGE_BYTES
    for (const item of items.slice(0, MAX_INBOUND_MEDIA)) {
      if (signal.aborted) return
      if (remaining <= 0) { message.attachmentErrors.push('附件总大小超过上限，其余附件未接收。'); break }
      const result = await saveInboundItem(item, { accountId, mediaRoot, cdnBaseUrl, messageId: message.at.toString(36), logger, signal, maxBytes: remaining })
      if (signal.aborted) return
      if (!result.ok) {
        message.attachmentErrors.push(`${result.kind} 附件未能下载或解码，请重新发送。`)
        logger.warn(`inbound ${result.kind} not saved: ${result.reason}`)
        continue
      }
      remaining -= result.media.bytes
      // A voice note that is still SILK cannot be transcribed; only the WAV the
      // vendored transcoder produced is worth handing to whisper.
      if (result.media.kind === 'voice' && result.media.mime === 'audio/wav' && asr !== undefined) {
        const transcription = await asr.transcribe(result.media.path)
        if (transcription.ok) {
          result.media.transcript = transcription.text
          logger.info(`transcribed voice note (${transcription.text.length} chars)`)
        } else {
          logger.warn(`voice note not transcribed: ${transcription.reason}`)
        }
      }
      message.media.push(result.media)
    }
  }

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '微信', en: 'WeChat' },
    capabilities: {
      // Voice outbound stays false on purpose: the server accepts it and never
      // delivers it, so audio goes out as a file.
      media: { image: true, file: true, voice: false, video: true },
      maxTextChars: 600,
    },
    accounts: {
      async list(): Promise<AccountInfo[]> {
        return [{ accountId, expired: expired.has(accountId) }]
      },
      markExpired(id: string, value = true): void {
        if (value) expired.add(id)
        else expired.delete(id)
      },
    },

    async start(): Promise<void> {
      if (inbound !== undefined) return
      inbound = new AbortController()
      asr = createAsr()
      if (asr !== undefined && !asr.available()) logger.warn('asr bridge not found: voice notes will be sent as files')
      transport.start()
      logger.info(`weixin adapter polling account ${accountId}`)
    },
    async stop(): Promise<void> {
      if (inbound === undefined) return
      if (stopping !== undefined) return stopping
      inbound.abort()
      stopping = Promise.all([transport.stop(), asr?.dispose()]).then(() => {
        inbound = undefined
        asr = undefined
        stopping = undefined
      })
      return stopping
    },
    onInbound(handler: (message: InboundMessage) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    restoreInbound(message: InboundMessage): void {
      const context = message.raw as { contextToken?: unknown } | undefined
      if (typeof context?.contextToken === 'string') transport.rememberContextToken(message.conversationId, context.contextToken, true)
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      if (target.channel !== CHANNEL_ID || target.accountId !== accountId) return { ok: false, code: 'account-mismatch' }
      const media = outgoing.media ?? []
      if (media.length > 0) {
        // One call per attachment; the caption rides on the first one, which is
        // how WeChat shows "text above a picture".
        let last: SendResult = { ok: false, code: 'empty' }
        for (const [index, item] of media.entries()) {
          last = await transport.sendMedia(target.conversationId, item.path, index === 0 ? outgoing.text ?? '' : '')
          if (!last.ok) return last
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
