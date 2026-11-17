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
 * @module @rodin/dsh-channels-telegram/transport
 */
import fs from 'node:fs'
import path from 'node:path'

import type { SendResult } from '@rodin/dsh-channels'
import type { TelegramUpdate } from './normalize.js'

export const DEFAULT_API_BASE = 'https://api.telegram.org'
/** Telegram's own limit for one message is 4096 characters. */
export const MAX_TEXT_CHARS = 4000

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; arrayBuffer?: () => Promise<ArrayBuffer> }>

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
  readonly #logger: TransportLogger
  readonly #fetch: FetchLike
  readonly #apiBase: string
  #offset = 0
  #stopped = false

  constructor(options: TransportOptions) {
    this.#options = options
    this.#logger = options.logger
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#apiBase = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  }

  #url(method: string): string {
    return `${this.#apiBase}/bot${this.#options.token}/${method}`
  }

  async #call<T>(method: string, body?: Record<string, unknown>): Promise<TelegramAnswer<T>> {
    const response = await this.#fetch(this.#url(method), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const answer = (await response.json().catch(() => ({}))) as TelegramAnswer<T>
    return answer
  }

  /**
   * One long poll. Returns the updates it got (empty on a timeout, which is
   * normal) and advances the offset past them, so a restart does not replay.
   */
  async pollOnce(): Promise<TelegramUpdate[]> {
    if (this.#stopped) return []
    const timeout = this.#options.pollTimeoutSeconds ?? 25
    const answer = await this.#call<TelegramUpdate[]>('getUpdates', {
      offset: this.#offset === 0 ? undefined : this.#offset,
      timeout,
      allowed_updates: ['message'],
      limit: 50,
    })
    if (answer.ok !== true || !Array.isArray(answer.result)) {
      const retry = answer.parameters?.retry_after
      throw new Error(`getUpdates failed: ${answer.description ?? 'no description'}${retry === undefined ? '' : ` (retry after ${retry}s)`}`)
    }
    const updates = answer.result
    for (const update of updates) {
      if (typeof update.update_id === 'number') this.#offset = Math.max(this.#offset, update.update_id + 1)
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
      const response = await this.#fetch(this.#url(method), { method: 'POST', body: form })
      const answer = (await response.json().catch(() => ({}))) as TelegramAnswer<{ message_id?: number }>
      if (answer.ok !== true) return { ok: false, code: 'send-media-failed', detail: answer.description ?? 'no description' }
      const messageId = answer.result?.message_id
      return typeof messageId === 'number' ? { ok: true, messageId: String(messageId) } : { ok: true, unconfirmed: true }
    } catch (error) {
      return { ok: false, code: 'send-media-failed', detail: String((error as Error)?.message ?? error) }
    }
  }

  /** Resolve a file id to a download URL, then fetch the bytes. */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; filePath: string } | { error: string }> {
    try {
      const answer = await this.#call<{ file_path?: string }>('getFile', { file_id: fileId })
      const filePath = answer.result?.file_path
      if (answer.ok !== true || typeof filePath !== 'string' || filePath === '') {
        return { error: answer.description ?? 'getFile returned no path' }
      }
      const url = `${this.#apiBase}/file/bot${this.#options.token}/${filePath}`
      const response = await this.#fetch(url)
      if (response.ok !== true || typeof response.arrayBuffer !== 'function') {
        return { error: `download failed with HTTP ${response.status}` }
      }
      return { bytes: Buffer.from(await response.arrayBuffer()), filePath }
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
    this.#stopped = true
  }
}
