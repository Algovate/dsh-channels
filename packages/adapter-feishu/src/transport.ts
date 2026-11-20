/**
 * The Feishu/Lark OpenAPI REST calls this adapter needs, and nothing else.
 *
 * Auth is a tenant access token exchanged with the app id/secret and cached
 * until it expires (the gateway ticket is fetched separately by the socket).
 * Every call is injectable (`fetchImpl`) so a test can step one request
 * without a network, and every failure is a value: a bad send is a bad send,
 * not a crash. Persistent connections carry the events; REST only moves
 * messages and files, mirroring how the Telegram adapter splits the two.
 *
 * @module @derekluo/dsh-channels-feishu/transport
 */
import fs from 'node:fs'
import path from 'node:path'

import type { OutgoingAction, SendResult } from '@derekluo/dsh-channels'

export const DEFAULT_DOMAIN = 'https://open.feishu.cn'
/** A text message is capped well below the documented limit to stay safe across tenants. */
export const MAX_TEXT_CHARS = 4000

const REQUEST_TIMEOUT_MS = 15_000
const TOKEN_SAFETY_MS = 60_000

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  body?: ReadableStream<Uint8Array> | null
}>

export interface TransportLogger {
  info: (line: string) => void
  warn: (line: string) => void
}

export interface TransportOptions {
  appId: string
  appSecret: string
  domain?: string
  logger: TransportLogger
  /** Injected in tests: the real fetch, so a request can be stepped. */
  fetchImpl?: FetchLike
}

interface ApiEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

interface ConnectConfig {
  URL: string
  ClientConfig: {
    PingInterval: number
    ReconnectCount: number
    ReconnectInterval: number
    ReconnectNonce: number
  }
}

interface TokenInfo { token: string; expiresAt: number }

/** The `file_type` enum the upload endpoint accepts; anything else is `stream`. */
function fileTypeFor(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  const allowed = new Set(['opus', 'mp4', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
  return allowed.has(extension) ? extension : 'stream'
}

/** Build the interactive-card content for one text body plus native actions. */
function cardContent(text: string, actions?: readonly OutgoingAction[]): string {  const elements: Array<Record<string, unknown>> = [
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
  readonly #options: TransportOptions
  readonly #fetch: FetchLike
  readonly #domain: string
  #token: TokenInfo | undefined
  #lifecycle = new AbortController()

  get signal(): AbortSignal { return this.#lifecycle.signal }

  constructor(options: TransportOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#domain = (options.domain ?? DEFAULT_DOMAIN).replace(/\/$/, '')
  }

  start(): void {
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController()
  }

  stop(): void {
    this.#lifecycle.abort(new Error('Feishu transport stopped'))
  }

  async #request<T>(
    url: string,
    init: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<ApiEnvelope<T>> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.signal, deadline.signal])
    signal.throwIfAborted()
    const timer = setTimeout(() => deadline.abort(new Error('Feishu request timed out')), timeoutMs)
    try {
      const response = await this.#fetch(url, { ...init, signal })
      const envelope = (await response.json().catch(() => ({}))) as ApiEnvelope<T>
      return envelope
    } finally {
      clearTimeout(timer)
    }
  }

  /** Exchange the app credentials for a tenant token, caching until near expiry. */
  async tenantToken(): Promise<string> {
    const now = Date.now()
    if (this.#token !== undefined && this.#token.expiresAt - TOKEN_SAFETY_MS > now) return this.#token.token
    const envelope = await this.#request<{ tenant_access_token?: string; expire?: number }>(
      `${this.#domain}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.#options.appId, app_secret: this.#options.appSecret }),
      },
    )
    // The token endpoint answers with the fields at the top level (no `data`
    // wrapper), unlike the rest of the OpenAPI, so accept both shapes.
    const flat = envelope as ApiEnvelope<{ tenant_access_token?: string; expire?: number }> & {
      tenant_access_token?: string
      expire?: number
    }
    const token = flat.tenant_access_token ?? envelope.data?.tenant_access_token
    if (envelope.code !== 0 || typeof token !== 'string' || token === '') {
      throw new Error(`tenant token exchange failed: ${envelope.msg ?? envelope.code ?? 'unknown error'}`)
    }
    const expireSeconds = flat.expire ?? envelope.data?.expire ?? 7200
    this.#token = { token, expiresAt: now + expireSeconds * 1000 }
    return token
  }

  #authHeaders(extra?: Record<string, string>): Record<string, string> {
    const token = this.#token?.token
    if (token === undefined) throw new Error('tenant token not available')
    return { authorization: `Bearer ${token}`, ...(extra ?? {}) }
  }

  /** Ensure a token, then return the auth header. Every authenticated call goes through here. */
  async #auth(extra?: Record<string, string>): Promise<Record<string, string>> {
    await this.tenantToken()
    return this.#authHeaders(extra)
  }

  /** Fetch the persistent-connection ticket and the gateway's timing config. */
  async pullConnectConfig(): Promise<ConnectConfig> {
    const envelope = await this.#request<ConnectConfig>(`${this.#domain}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', locale: 'zh' },
      body: JSON.stringify({ AppID: this.#options.appId, AppSecret: this.#options.appSecret }),
    })
    if (envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(`ws endpoint discovery failed: ${envelope.msg ?? envelope.code ?? 'unknown error'}`)
    }
    return envelope.data
  }

  /** Send one text message, optionally with native card buttons. */
  async sendText(chatId: string, text: string, actions?: readonly OutgoingAction[]): Promise<SendResult> {
    try {
      const useCard = actions !== undefined && actions.length > 0
      const body = {
        receive_id: chatId,
        msg_type: useCard ? 'interactive' : 'text',
        content: useCard ? cardContent(text, actions) : JSON.stringify({ text }),
      }
      const envelope = await this.#request<{ message_id?: string }>(
        `${this.#domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { method: 'POST', headers: await this.#auth({ 'content-type': 'application/json; charset=utf-8' }), body: JSON.stringify(body) },
      )
      return this.#toSendResult(envelope, 'send-failed')
    } catch (error) {
      return { ok: false, code: 'send-failed', detail: String((error as Error)?.message ?? error) }
    }
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
      const body = { msg_type: 'interactive', content: cardContent(text, actions) }
      const envelope = await this.#request<{ message_id?: string }>(
        `${this.#domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        { method: 'PATCH', headers: await this.#auth({ 'content-type': 'application/json; charset=utf-8' }), body: JSON.stringify(body) },
      )
      if (envelope.code !== 0) return { ok: false, code: 'edit-failed', detail: envelope.msg ?? 'no description' }
      return { ok: true, messageId }
    } catch (error) {
      return { ok: false, code: 'edit-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Send a card message (text plus optional buttons); only cards are editable later. */
  async sendCard(chatId: string, text: string, actions?: readonly OutgoingAction[]): Promise<SendResult> {
    try {
      const body = { receive_id: chatId, msg_type: 'interactive', content: cardContent(text, actions) }
      const envelope = await this.#request<{ message_id?: string }>(
        `${this.#domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { method: 'POST', headers: await this.#auth({ 'content-type': 'application/json; charset=utf-8' }), body: JSON.stringify(body) },
      )
      return this.#toSendResult(envelope, 'send-failed')
    } catch (error) {
      return { ok: false, code: 'send-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Upload one local image and return its image_key. */
  async uploadImage(filePath: string): Promise<string> {
    const form = new FormData()
    form.set('image_type', 'message')
    form.set('image', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
    const envelope = await this.#request<{ image_key?: string }>(`${this.#domain}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: await this.#auth(),
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
    const envelope = await this.#request<{ file_key?: string }>(`${this.#domain}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: await this.#auth(),
      body: form,
    })
    const key = envelope.data?.file_key
    if (envelope.code !== 0 || typeof key !== 'string' || key === '') throw new Error(envelope.msg ?? 'file upload failed')
    return key
  }

  /** Send one already-uploaded resource as a chat message with an optional caption. */
  async sendResource(chatId: string, kind: 'image' | 'file' | 'video' | 'voice', key: string, caption: string): Promise<SendResult> {
    try {
      const msgType = kind === 'image' ? 'image' : kind === 'video' ? 'media' : kind === 'voice' ? 'audio' : 'file'
      const content = kind === 'image'
        ? JSON.stringify({ image_key: key })
        : kind === 'video'
          ? JSON.stringify({ file_key: key, image_key: '' })
          : kind === 'voice'
            ? JSON.stringify({ file_key: key })
            : JSON.stringify({ file_key: key })
      const envelope = await this.#request<{ message_id?: string }>(
        `${this.#domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: 'POST',
          headers: await this.#auth({ 'content-type': 'application/json; charset=utf-8' }),
          body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
        },
      )
      const result = this.#toSendResult(envelope, 'send-media-failed')
      if (result.ok && caption !== '') {
        await this.sendText(chatId, caption).catch(() => { /* The resource already landed; the caption is best effort. */ })
      }
      return result
    } catch (error) {
      return { ok: false, code: 'send-media-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Download an inbound resource (image, file, video or audio) with a hard byte cap. */
  async downloadResource(messageId: string, fileKey: string, type: string, maxBytes: number): Promise<{ bytes: Buffer } | { error: string }> {
    try {
      await this.tenantToken()
      const url = `${this.#domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`
      const response = await this.#fetch(url, { headers: await this.#auth(), signal: this.signal })
      if (!response.ok || response.body == null) {
        void response.body?.cancel().catch(() => {})
        return { error: `download failed with HTTP ${response.status}` }
      }
      const reader = response.body.getReader()
      const cancel = (): void => { void reader.cancel().catch(() => {}) }
      this.signal.addEventListener('abort', cancel, { once: true })
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
        this.signal.removeEventListener('abort', cancel)
        reader.releaseLock()
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) }
    }
  }

  #toSendResult(envelope: ApiEnvelope<{ message_id?: string }>, failedCode: string): SendResult {
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
}
