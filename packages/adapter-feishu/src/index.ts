/**
 * The Feishu/Lark adapter.
 *
 * Same shape as the Telegram adapter and deliberately no bigger: it knows how
 * to hold one persistent WebSocket, how to turn a reassembled event into a
 * normalized message, how to download inbound resources, and how to send text,
 * cards and files. Turns, queues, gates, retries, interactions and state all
 * live in @derekluo/dsh-channels — this file is the evidence the split holds,
 * because it shares no line of WeChat or Telegram code.
 *
 * Events arrive over a long-lived connection (no public webhook), and REST only
 * moves messages and files. The WebSocket uses the `ws` package — the same
 * transport the official Feishu SDK uses, delivering Node Buffers rather than
 * the global WebSocket's Blob frames — while REST uses the built-in fetch. The
 * only runtime dependency is `ws`; the protobuf frame codec is hand-written.
 *
 * @module @derekluo/dsh-channels-feishu
 */
import path from 'node:path'

import type { AccountInfo, AdapterRuntime, ChannelAdapter, InboundMedia, IngressSink, Outgoing, SendResult, Target } from '@derekluo/dsh-channels'
import { AsrBridge, sharedAsrScript } from './asr.js'
import { saveInboundAttachment } from './attachments.js'
import { createDispatcher } from './polling.js'
import { FeishuSocket } from './socket.js'
import { FeishuTransport, MAX_TEXT_CHARS, type FetchLike } from './transport.js'
import { CHANNEL_ID, normalizeInbound, type NormalizedInbound } from './normalize.js'

export { CHANNEL_ID, normalizeInbound } from './normalize.js'
export { decodeFrame, encodeFrame } from './proto.js'

export interface FeishuAdapterOptions {
  ctx?: unknown
  runtime?: AdapterRuntime
  stateRoot?: string
  config?: {
    appId?: string
    appSecret?: string
    /** Override the OpenAPI domain, e.g. https://open.larksuite.com for Lark. */
    domain?: string
    /** Optional display label; the account id is derived from the app id. */
    botId?: string
    mediaEnabled?: boolean
    maxInboundBytes?: number
    /** Transcribe inbound voice notes with the shipped Python bridge (default on). */
    asrEnabled?: boolean
    /** Python interpreter for the bridge; defaults to python3. */
    asrCommand?: string
    /** Where whisper checkpoints live; defaults to <state>/asr-models. */
    asrModelDir?: string
    asrLanguage?: string
    /** Whisper size ("large-v3-turbo") or an explicit checkpoint path; default small. */
    asrModel?: string
    /** faster-whisper device: "cpu" (default) or "mps" on Apple Silicon. */
    asrDevice?: string
    /** ctranslate2 compute type; defaults to int8 on cpu, float16 on mps. */
    asrComputeType?: string
    asrTimeoutMs?: number
    /** Override the shipped bridge script (e.g. a custom transcriber). */
    asrScriptPath?: string
    /** Injected in tests: the real fetch, so a request can be stepped. */
    fetchImpl?: FetchLike
    /** Injected in tests: a fake WebSocket constructor. */
    webSocketImpl?: ConstructorParameters<typeof FeishuSocket>[0]['webSocketImpl']
    /** Injected in tests: a fake spawn for the ASR bridge. */
    asrSpawnImpl?: ConstructorParameters<typeof AsrBridge>[0]['spawnImpl']
  }
}

const MAX_INBOUND_MEDIA = 8
const DEFAULT_MAX_INBOUND_BYTES = 20 * 1024 * 1024

export async function createAdapter({ runtime, config = {}, stateRoot = '' }: FeishuAdapterOptions): Promise<ChannelAdapter> {
  const logger = runtime?.logger ?? { info: () => {}, warn: () => {} }
  const appId = (config.appId ?? '').trim()
  const appSecret = (config.appSecret ?? '').trim()
  if (appId === '' || appSecret === '') {
    throw new Error('no Feishu app credentials configured (adapterConfig["@derekluo/dsh-channels-feishu"].appId/appSecret)')
  }
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) throw new Error(`invalid Feishu app id: expected cli_ followed by 16 hex characters, got ${appId}`)
  const accountId = `app:${appId}`
  const label = (config.botId ?? '').trim() || appId
  const mediaRoot = stateRoot === '' ? '' : path.join(stateRoot, 'media', 'inbound')
  const maxInboundBytes = Number.isFinite(config.maxInboundBytes) ? Math.max(0, Number(config.maxInboundBytes)) : DEFAULT_MAX_INBOUND_BYTES
  const mediaEnabled = config.mediaEnabled !== false && mediaRoot !== ''
  if (config.mediaEnabled !== false && mediaRoot === '') logger.warn('no state root: Feishu media will not be saved')

  // Voice notes become text when python + whisper are available; otherwise the
  // audio path travels and the model is told it could not be transcribed. The
  // bridge is optional on purpose: a channel plugin may not require python.
  const scriptPath = config.asrScriptPath ?? sharedAsrScript()
  if (config.asrEnabled !== false && scriptPath === undefined) logger.warn('asr bridge not found: voice notes will not be transcribed')
  const asr = (config.asrEnabled ?? true) && stateRoot !== '' && scriptPath !== undefined
    ? new AsrBridge({
        scriptPath,
        modelDir: config.asrModelDir ?? path.join(stateRoot, 'asr-models'),
        ...(config.asrCommand === undefined ? {} : { command: config.asrCommand }),
        ...(config.asrModel === undefined ? {} : { model: config.asrModel }),
        ...(config.asrDevice === undefined ? {} : { device: config.asrDevice }),
        ...(config.asrComputeType === undefined ? {} : { computeType: config.asrComputeType }),
        ...(config.asrLanguage === undefined ? {} : { language: config.asrLanguage }),
        ...(config.asrTimeoutMs === undefined ? {} : { timeoutMs: config.asrTimeoutMs }),
        ...(config.asrSpawnImpl === undefined ? {} : { spawnImpl: config.asrSpawnImpl }),
        logger,
      })
    : undefined

  const transport = new FeishuTransport({
    appId,
    appSecret,
    ...(config.domain === undefined ? {} : { domain: config.domain }),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  })
  let socket: FeishuSocket | undefined

  const handleMessage = async (message: NormalizedInbound): Promise<void> => {
    const descriptors = message.mediaItems ?? []
    const items = descriptors.slice(0, MAX_INBOUND_MEDIA)
    message.attachmentErrors ??= []
    if (descriptors.length > items.length) message.attachmentErrors.push('附件数量超过上限，其余附件未接收。')
    if (items.length && !mediaEnabled) message.attachmentErrors.push('附件接收未启用，请发送文字。')
    if (runtime?.canReceive?.(message, items.length > 0 || message.media.length > 0) === false) return
    try {
      delete message.mediaItems
      if (items.length > 0 && mediaEnabled) {
        for (const item of items) {
          const saved = await saveInboundAttachment(item, { transport, accountId, mediaRoot, maxInboundBytes, logger })
          if (transport.signal.aborted) return
          if (saved !== undefined) {
            // Only voice notes are worth transcribing, and only when the bridge
            // is actually usable; a failed transcription must not drop the audio.
            if (saved.kind === 'voice' && asr !== undefined && asr.available()) {
              const transcription = await asr.transcribe(saved.path)
              if (transcription.ok) {
                saved.transcript = transcription.text
                logger.info(`transcribed voice note (${transcription.text.length} chars)`)
              } else {
                logger.warn(`voice note not transcribed: ${transcription.reason}`)
              }
            }
            message.media.push(saved)
          } else message.attachmentErrors.push(`${item.kind} 附件未能下载或超过大小上限，请重新发送。`)
        }
      }
      await sink.offer(message, { priority: items.length === 0 && runtime?.canBypassInbound?.(message) === true })
    } finally {
      runtime?.cancelReceive?.(message)
    }
  }

  let sink: IngressSink
  const dispatcher = createDispatcher({
    accountId,
    priority: (message) => runtime?.canBypassInbound?.(message) === true,
    deliver: handleMessage,
    normalize: normalizeInbound,
    logger,
  })

  const adapter: ChannelAdapter = {
    id: CHANNEL_ID,
    label: { zh: '飞书', en: 'Feishu' },
    capabilities: {
      media: { image: true, file: true, voice: true, video: true },
      actions: true,
      edit: true,
      maxTextChars: MAX_TEXT_CHARS,
    },
    accounts: {
      async list(): Promise<AccountInfo[]> {
        return [{ accountId, label, expired: false }]
      },
    },

    async startWithSink(next: IngressSink): Promise<void> {
      if (socket !== undefined) return
      sink = next
      transport.start()
      socket = new FeishuSocket({
        transport,
        logger,
        onEvent: (envelope) => dispatcher.onEvent(envelope),
        ...(config.webSocketImpl === undefined ? {} : { webSocketImpl: config.webSocketImpl }),
      })
      socket.start()
      logger.info(`feishu adapter connecting app ${accountId}`)
    },
    async stop(): Promise<void> {
      const current = socket
      socket = undefined
      if (current !== undefined) await current.stop()
      transport.stop()
      await asr?.dispose().catch((error: unknown) => logger.warn(`asr bridge did not stop cleanly: ${String(error)}`))
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      if (target.channel !== CHANNEL_ID || target.accountId !== accountId) return { ok: false, code: 'account-mismatch' }
      const media = outgoing.media ?? []
      if (media.length > 0) {
        let last: SendResult = { ok: false, code: 'empty' }
        for (const [index, item] of media.entries()) {
          try {
            const key = item.kind === 'image'
              ? await transport.uploadImage(item.path)
              : await transport.uploadFile(item.path, item.kind, undefined)
            last = await transport.sendResource(target.conversationId, item.kind, key, index === 0 ? outgoing.text ?? '' : '')
          } catch (error) {
            return { ok: false, code: 'send-media-failed', detail: String((error as Error)?.message ?? error) }
          }
          if (!last.ok) return last
        }
        return last
      }
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      // A notice is the receipt the core later PATCHes into the task card, and
      // Feishu only lets an interactive message be edited; actions also need a
      // card. Plain model replies stay text messages.
      const needsCard = outgoing.kind === 'notice' || (outgoing.actions?.length ?? 0) > 0
      if (needsCard) return transport.sendCard(target.conversationId, text, outgoing.actions)
      return transport.sendText(target.conversationId, text)
    },
    async edit(target: Target, messageId: string, outgoing: Outgoing): Promise<SendResult> {
      if (target.channel !== CHANNEL_ID || target.accountId !== accountId) return { ok: false, code: 'account-mismatch' }
      if ((outgoing.media ?? []).length > 0) return { ok: false, code: 'media-unsupported' }
      const text = outgoing.text ?? ''
      if (text === '') return { ok: false, code: 'empty' }
      return transport.editMessage(target.conversationId, messageId, text, outgoing.actions)
    },
  }
  return adapter
}
