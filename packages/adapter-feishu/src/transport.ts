/**
 * The Feishu/Lark message-and-media calls this adapter needs.
 *
 * Transport is a thin layer over {@link FeishuApi}: it shapes message content
 * (text, interactive cards, uploaded resources) and moves bytes, while the API
 * object owns URLs, headers, tokens and deadlines. Persistent connections carry
 * the events; REST only moves messages and files, mirroring how the Telegram
 * adapter splits the two. Every method returns a value rather than throwing:
 * a bad send is a bad send, not a crash.
 *
 * @module @derekluo/dsh-channels-feishu/transport
 */
import fs from 'node:fs'
import path from 'node:path'

import type { OutgoingAction, SendResult } from '@derekluo/dsh-channels'
import { FeishuApi, type ApiEnvelope, type ApiOptions, type ConnectConfig } from './api.js'

export { DEFAULT_DOMAIN, type FetchLike, type TransportLogger } from './api.js'

/** A text message is capped well below the documented limit to stay safe across tenants. */
export const MAX_TEXT_CHARS = 4000

export type TransportOptions = ApiOptions

/** The `file_type` enum the upload endpoint accepts; anything else is `stream`. */
function fileTypeFor(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  const allowed = new Set(['opus', 'mp4', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
  return allowed.has(extension) ? extension : 'stream'
}

/** Build the interactive-card content for one text body plus native actions. */
function cardContent(text: string, actions?: readonly OutgoingAction[]): string {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: text } },
  ]
  if (actions !== undefined && actions.length > 0) {
    elements.push({
      tag: 'action',
      actions: actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: action.label.slice(0, 60) },
        type: 'default',
        // The gateway hands `action.value` back verbatim on a card.action.trigger.
        value: { value: action.value.slice(0, 200) },
      })),
    })
  }
  return JSON.stringify({ config: { wide_screen_mode: true }, elements })
}

export class FeishuTransport {
  readonly #api: FeishuApi

  constructor(options: TransportOptions) {
    this.#api = new FeishuApi(options)
  }

  get signal(): AbortSignal { return this.#api.signal }

  start(): void { this.#api.start() }
  stop(): void { this.#api.stop() }

  async pullConnectConfig(): Promise<ConnectConfig> {
    return this.#api.pullConnectConfig()
  }

  /** Post one message and map the envelope; the one place that builds the URL. */
  async #postMessage(chatId: string, msgType: string, content: string, failedCode: string): Promise<SendResult> {
    try {
      const envelope = await this.#api.request<{ message_id?: string }>('/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: await this.#api.auth({ 'content-type': 'application/json; charset=utf-8' }),
        body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
      })
      return toSendResult(envelope, failedCode)
    } catch (error) {
      return { ok: false, code: failedCode, detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Send one plain text message. */
  sendText(chatId: string, text: string): Promise<SendResult> {
    return this.#postMessage(chatId, 'text', JSON.stringify({ text }), 'send-failed')
  }

  /**
   * Replace a previously sent card message in place.
   *
   * Feishu's PATCH endpoint only accepts `interactive` messages — patching a
   * plain text message fails with "This message is NOT a card." The core's
   * task card is therefore always sent as a card (see {@link sendCard}), and
   * edit always writes card content, with or without buttons.
   */
  async editMessage(chatId: string, messageId: string, text: string, actions?: readonly OutgoingAction[]): Promise<SendResult> {
    try {
      const envelope = await this.#api.request<{ message_id?: string }>(
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PATCH',
          headers: await this.#api.auth({ 'content-type': 'application/json; charset=utf-8' }),
          body: JSON.stringify({ msg_type: 'interactive', content: cardContent(text, actions) }),
        },
      )
      if (envelope.code !== 0) return { ok: false, code: 'edit-failed', detail: envelope.msg ?? 'no description' }
      return { ok: true, messageId }
    } catch (error) {
      return { ok: false, code: 'edit-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Send a card message (text plus optional buttons); only cards are editable later. */
  sendCard(chatId: string, text: string, actions?: readonly OutgoingAction[]): Promise<SendResult> {
    return this.#postMessage(chatId, 'interactive', cardContent(text, actions), 'send-failed')
  }

  /** Upload one local image and return its image_key. */
  async uploadImage(filePath: string): Promise<string> {
    const form = new FormData()
    form.set('image_type', 'message')
    form.set('image', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
    const envelope = await this.#api.request<{ image_key?: string }>('/open-apis/im/v1/images', {
      method: 'POST',
      headers: await this.#api.auth(),
      body: form,
    })
    const key = envelope.data?.image_key
    if (envelope.code !== 0 || typeof key !== 'string' || key === '') throw new Error(envelope.msg ?? 'image upload failed')
    return key
  }

  /** Upload one local file/video/audio and return its file_key. */
  async uploadFile(filePath: string, kind: 'file' | 'video' | 'voice', durationMs?: number): Promise<string> {
    const fileType = kind === 'video' ? 'mp4' : kind === 'voice' ? 'opus' : fileTypeFor(filePath)
    const form = new FormData()
    form.set('file_type', fileType)
    form.set('file_name', path.basename(filePath))
    form.set('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
    if (kind === 'video') form.set('duration', String(Math.max(1, Math.round((durationMs ?? 0) / 1000))))
    const envelope = await this.#api.request<{ file_key?: string }>('/open-apis/im/v1/files', {
      method: 'POST',
      headers: await this.#api.auth(),
      body: form,
    })
    const key = envelope.data?.file_key
    if (envelope.code !== 0 || typeof key !== 'string' || key === '') throw new Error(envelope.msg ?? 'file upload failed')
    return key
  }

  /** Send one already-uploaded resource as a chat message with an optional caption. */
  async sendResource(chatId: string, kind: 'image' | 'file' | 'video' | 'voice', key: string, caption: string): Promise<SendResult> {
    const msgType = kind === 'image' ? 'image' : kind === 'video' ? 'media' : kind === 'voice' ? 'audio' : 'file'
    const content = kind === 'image' ? JSON.stringify({ image_key: key }) : JSON.stringify({ file_key: key, ...(kind === 'video' ? { image_key: '' } : {}) })
    const result = await this.#postMessage(chatId, msgType, content, 'send-media-failed')
    if (result.ok && caption !== '') {
      await this.sendText(chatId, caption).catch(() => { /* The resource already landed; the caption is best effort. */ })
    }
    return result
  }

  /** Download an inbound resource (image, file, video or audio) with a hard byte cap. */
  async downloadResource(messageId: string, fileKey: string, type: string, maxBytes: number): Promise<{ bytes: Buffer } | { error: string }> {
    try {
      const url = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`
      const response = await this.#api.requestStream(url, { headers: await this.#api.auth() })
      if (!response.ok || response.body == null) {
        void response.body?.cancel().catch(() => {})
        return { error: `download failed with HTTP ${response.status}` }
      }
      const reader = response.body.getReader()
      const signal = this.#api.signal
      const cancel = (): void => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const chunks: Uint8Array[] = []
        let size = 0
        const overCap = `resource exceeds ${maxBytes} bytes`
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return { bytes: Buffer.concat(chunks, size) }
          size += chunk.value.byteLength
          if (size > maxBytes) {
            cancel()
            return { error: overCap }
          }
          chunks.push(chunk.value)
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        reader.releaseLock()
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) }
    }
  }
}

/** Map a send envelope to the core's three-state result. */
function toSendResult(envelope: ApiEnvelope<{ message_id?: string }>, failedCode: string): SendResult {
  if (envelope.code !== 0) {
    return {
      ok: false,
      code: envelope.code === 99991663 || envelope.code === 99991664 ? 'rate-limited' : failedCode,
      detail: envelope.msg ?? 'no description',
    }
  }
  const messageId = envelope.data?.message_id
  return typeof messageId === 'string' && messageId !== '' ? { ok: true, messageId } : { ok: true, unconfirmed: true }
}
