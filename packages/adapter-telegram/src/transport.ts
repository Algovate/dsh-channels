/**
 * The Telegram Bot API calls this adapter needs, and nothing else.
 *
 * Long polling rather than a webhook: a webhook needs a public HTTPS endpoint,
 * which is exactly what a machine behind a home router does not have, and the
 * reference implementation learned that the hard way. `getUpdates` with a
 * timeout keeps one HTTP request open and answers with every update since the
 * last offset — no server, no certificate, no tunnel.
 *
 * Every call is injectable (`fetchImpl`) so a test can step one poll without a
 * network, and every failure is a value: a bad poll is a bad poll, not a crash.
 *
 * @module @derekluo/dsh-channels-telegram/transport
 */
import fs from 'node:fs'
import path from 'node:path'

import type { SendResult } from '@derekluo/dsh-channels'
import type { TelegramUpdate } from './normalize.js'

export const DEFAULT_API_BASE = 'https://api.telegram.org'
/** Telegram's own limit for one message is 4096 characters. */
export const MAX_TEXT_CHARS = 4000

const REQUEST_TIMEOUT_MS = 15_000
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
  token: string
  apiBaseUrl?: string
  /** Long-poll timeout in seconds (Telegram allows up to 50). */
  pollTimeoutSeconds?: number
  logger: TransportLogger
  fetchImpl?: FetchLike
}

interface TelegramAnswer<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export class TelegramTransport {
  readonly #options: TransportOptions
  readonly #fetch: FetchLike
  readonly #apiBase: string
  #lifecycle = new AbortController()
  get signal(): AbortSignal { return this.#lifecycle.signal }

  start(): void {
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController()
  }
  #offset = 0

  constructor(options: TransportOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#apiBase = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  }

  #url(method: string): string {
    return `${this.#apiBase}/bot${this.#options.token}/${method}`
  }

  async #request<T>(
    url: string,
    init: Record<string, unknown>,
    read: (response: Awaited<ReturnType<FetchLike>>, signal: AbortSignal) => Promise<T>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.signal, deadline.signal])
    signal.throwIfAborted()
    const timer = setTimeout(() => deadline.abort(new Error('Telegram request timed out')), timeoutMs)
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const response = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        const received = await this.#fetch(url, { ...init, signal })
        signal.throwIfAborted()
        return read(received, signal)
      })
      return await Promise.race([response, aborted])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  #answer<T>(method: string, init: Record<string, unknown>, timeoutMs?: number): Promise<TelegramAnswer<T>> {
    return this.#request(this.#url(method), init, async (response) =>
      (await response.json().catch(() => ({}))) as TelegramAnswer<T>, timeoutMs)
  }

  #call<T>(method: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<TelegramAnswer<T>> {
    return this.#answer<T>(method, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, timeoutMs)
  }

  /**
   * One long poll. Returns the updates it got (empty on a timeout, which is
   * normal). The next poll confirms the previous batch with its offset.
   */
  async pollOnce(): Promise<TelegramUpdate[]> {
    if (this.signal.aborted) return []
    const configuredTimeout = this.#options.pollTimeoutSeconds ?? 25
    const timeout = Number.isFinite(configuredTimeout) ? Math.max(0, Math.min(50, Math.floor(configuredTimeout))) : 25
    const answer = await this.#call<TelegramUpdate[]>('getUpdates', {
      offset: this.#offset === 0 ? undefined : this.#offset,
      timeout,
      allowed_updates: ['message'],
      limit: 50,
    }, timeout * 1000 + REQUEST_TIMEOUT_MS)
    if (answer.ok !== true || !Array.isArray(answer.result)) {
      const retry = answer.parameters?.retry_after
      throw new Error(`getUpdates failed: ${answer.description ?? 'no description'}${retry === undefined ? '' : ` (retry after ${retry}s)`}`)
    }
    const updates = answer.result
    for (const update of updates) {
      const id = update?.update_id
      if (id !== undefined && Number.isSafeInteger(id)) this.#offset = Math.max(this.#offset, id + 1)
    }
    return updates
  }

  /** Send one text message. Never throws: the caller decides what a failure means. */
  async sendText(chatId: string, text: string): Promise<SendResult> {
    try {
      const answer = await this.#call<{ message_id?: number }>('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      })
      if (answer.ok !== true) {
        const retry = answer.parameters?.retry_after
        return {
          ok: false,
          code: answer.error_code === 429 ? 'rate-limited' : 'send-failed',
          detail: answer.description ?? 'no description',
          ...(retry === undefined ? {} : { retryAfterMs: retry * 1000 }),
        }
      }
      const messageId = answer.result?.message_id
      return typeof messageId === 'number' ? { ok: true, messageId: String(messageId) } : { ok: true, unconfirmed: true }
    } catch (error) {
      return { ok: false, code: 'send-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /**
   * Upload and send one local file.
   *
   * Telegram takes the bytes in a multipart body, not a path, so the file is
   * read here; a 2GB video would be a bad idea and the core's produced-file caps
   * already bound what gets this far.
   */
  async sendFile(chatId: string, filePath: string, caption: string, kind: 'image' | 'video' | 'file'): Promise<SendResult> {
    const method = kind === 'image' ? 'sendPhoto' : kind === 'video' ? 'sendVideo' : 'sendDocument'
    const field = kind === 'image' ? 'photo' : kind === 'video' ? 'video' : 'document'
    try {
      const file = fs.readFileSync(filePath)
      const form = new FormData()
      form.set('chat_id', chatId)
      if (caption !== '') form.set('caption', caption.slice(0, 1000))
      form.set(field, new Blob([file]), path.basename(filePath))
      const answer = await this.#answer<{ message_id?: number }>(method, { method: 'POST', body: form })
      if (answer.ok !== true) return { ok: false, code: 'send-media-failed', detail: answer.description ?? 'no description' }
      const messageId = answer.result?.message_id
      return typeof messageId === 'number' ? { ok: true, messageId: String(messageId) } : { ok: true, unconfirmed: true }
    } catch (error) {
      return { ok: false, code: 'send-media-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Resolve a file id to a download URL, then fetch the bytes. */
  async downloadFile(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; filePath: string } | { error: string }> {
    try {
      const answer = await this.#call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
      const filePath = answer.result?.file_path
      if (answer.ok !== true || typeof filePath !== 'string' || filePath === '') {
        return { error: answer.description ?? 'getFile returned no path' }
      }
      const overCap = `file exceeds ${maxBytes} bytes`
      if (typeof answer.result?.file_size === 'number' && answer.result.file_size > maxBytes) return { error: overCap }
      const url = `${this.#apiBase}/file/bot${this.#options.token}/${filePath}`
      const bytes = await this.#request(url, {}, async (response, signal) => {
        if (!response.ok || response.body == null) {
          void response.body?.cancel().catch(() => {})
          throw new Error(`download failed with HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const cancel = (): void => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          const chunks: Uint8Array[] = []
          let size = 0
          while (true) {
            const chunk = await reader.read()
            signal.throwIfAborted()
            if (chunk.done) return Buffer.concat(chunks, size)
            size += chunk.value.byteLength
            if (size > maxBytes) {
              cancel()
              throw new Error(overCap)
            }
            chunks.push(chunk.value)
          }
        } finally {
          signal.removeEventListener('abort', cancel)
          reader.releaseLock()
        }
      })
      return { bytes, filePath }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) }
    }
  }

  /** Show "typing…" while a turn runs; a failure is cosmetic. */
  async typing(chatId: string): Promise<void> {
    try {
      await this.#call('sendChatAction', { chat_id: chatId, action: 'typing' })
    } catch {
      // The person sees the reply instead; a missing typing indicator is not news.
    }
  }

  stop(): void {
    this.#lifecycle.abort(new Error('Telegram transport stopped'))
  }
}
