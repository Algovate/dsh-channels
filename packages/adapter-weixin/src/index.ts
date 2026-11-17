/**
 * The Weixin adapter: iLink in, one normalized message per person-message out.
 *
 * It knows the platform and nothing else. Everything about turns, queues,
 * interactions and storage lives in the core, which is what makes a second
 * channel a few hundred lines instead of a copy of this file.
 *
 * @module @rodin/dsh-channels-weixin
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CDN_BASE_URL, listIndexedWeixinAccountIds } from '../vendor/openclaw-weixin/auth/accounts.js'
import type { AccountInfo, AdapterRuntime, ChannelAdapter, InboundMessage, InteractionReply, InteractionView, Outgoing, SendResult, Target } from '@rodin/dsh-channels'
import { mediaItemsOf, normalizeInbound, type NormalizedInbound, type RawMediaItem, type RawMessage } from './normalize.js'
import { MAX_INBOUND_MEDIA, saveInboundItem } from './media.js'
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
      const { conversationId, contextToken } = message
      // Slow attachments must not make later messages pass earlier ones in the same chat.
      const queued = (inbox.get(conversationId) ?? Promise.resolve()).then(async () => {
        if (signal.aborted || runtime?.canReceive?.(message, items.length > 0) === false) return
        try {
          await attachMedia(message, items, signal)
          if (signal.aborted) return
          transport.rememberContextToken(conversationId, contextToken)
          for (const handler of handlers) handler(message)
        } finally {
          runtime?.cancelReceive?.(message)
        }
      }).catch((error: unknown) => logger.warn(`inbound processing failed: ${String((error as Error)?.message ?? error)}`))
      inbox.set(conversationId, queued)
      return queued.then(() => {
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
  /** Fetch the attachments of one message, in parallel, without failing the message. */
  const attachMedia = async (message: NormalizedInbound, items: RawMediaItem[], signal: AbortSignal): Promise<void> => {
    if (!mediaEnabled || items.length === 0) return
    const saved = await Promise.all(
      items.slice(0, MAX_INBOUND_MEDIA).map((item) =>
        saveInboundItem(item, { accountId, mediaRoot, cdnBaseUrl, messageId: message.at.toString(36), logger, signal })),
    )
    for (const result of saved) {
      if (signal.aborted) return
      if (!result.ok) {
        logger.warn(`inbound ${result.kind} not saved: ${result.reason}`)
        continue
      }
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
