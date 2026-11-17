/**
 * The iLink long poll and text send, driven by this adapter.
 *
 * The vendored package ships a monitor that wants an OpenClaw channel runtime;
 * this adapter owns its own dispatch (one conversation = one DSH session), so it
 * drives `getUpdates` directly and reuses only the pure HTTP layer.
 *
 * Failure policy (all of it learned from the reference implementation):
 *  - one bad poll is a bad poll: count it, back off, keep polling;
 *  - `errcode` matters as much as `ret` — an expired session answers
 *    `{errcode: -14}` with `ret` absent, and a loop that only checks `ret` keeps
 *    polling forever while receiving nothing;
 *  - a poll round is bounded from outside, because the vendor timeout covers
 *    only the fetch and a stalled body would hang the loop.
 *
 * @module @rodin/dsh-channels-weixin/transport
 */
import { getUpdates } from '../vendor/openclaw-weixin/api/api.js'
import { DEFAULT_BASE_URL, loadWeixinAccount } from '../vendor/openclaw-weixin/auth/accounts.js'
import { MessageItemType } from '../vendor/openclaw-weixin/api/types.js'
import { sendMessageItemWeixin } from '../vendor/openclaw-weixin/messaging/send.js'
import { sendWeixinMediaFile } from '../vendor/openclaw-weixin/messaging/send-media.js'
import { CDN_BASE_URL as DEFAULT_CDN_BASE_URL } from '../vendor/openclaw-weixin/auth/accounts.js'
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from '../vendor/openclaw-weixin/storage/sync-buf.js'
import type { SendResult } from '@rodin/dsh-channels'
import type { RawMessage } from './normalize.js'

export const SESSION_EXPIRED_ERRCODE = -14
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const MAX_CONSECUTIVE_FAILURES = 3
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class SessionRejectedError extends Error {
  readonly errcode: number
  readonly sessionExpired: boolean
  constructor(errcode: number, errmsg?: string) {
    super(`getUpdates errcode=${errcode} errmsg=${errmsg ?? '(none)'}`)
    this.name = 'SessionRejectedError'
    this.errcode = errcode
    this.sessionExpired = errcode === SESSION_EXPIRED_ERRCODE
  }
}

export interface TransportLogger {
  info: (line: string) => void
  warn: (line: string) => void
}

/** What the transport needs from the account store. */
export function readAccount(accountId: string): { token: string; baseUrl: string } | undefined {
  const account = loadWeixinAccount(accountId) as { token?: string; baseUrl?: string } | null
  const token = typeof account?.token === 'string' ? account.token.trim() : ''
  if (token === '') return undefined
  const baseUrl = typeof account?.baseUrl === 'string' && account.baseUrl.trim() !== '' ? account.baseUrl.trim() : DEFAULT_BASE_URL
  return { token, baseUrl }
}

export interface TransportOptions {
  accountId: string
  baseUrl: string
  token: string
  logger: TransportLogger
  onMessage: (raw: RawMessage) => void
  onSessionRejected: (expired: boolean) => void
  longPollTimeoutMs?: number
  /** Injected in tests: the real iLink poll. */
  getUpdatesImpl?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Injected in tests: the real iLink send. */
  sendImpl?: (params: Record<string, unknown>) => Promise<{ messageId?: string; serverMessageId?: string }>
  /** Injected in tests: the real iLink media upload+send. */
  sendMediaImpl?: (params: Record<string, unknown>) => Promise<{ messageId?: string; serverMessageId?: string }>
  /** Retry delays; tests shrink them so a retry is observable without waiting. */
  retryDelayMs?: number
  backoffDelayMs?: number
  /** Outbound pacing: minimum gap between sends, and the cooldown after three failures. */
  sendIntervalMs?: number
  sendCooldownMs?: number
  cdnBaseUrl?: string
}

export class WeixinTransport {
  readonly #options: TransportOptions
  #running = false
  #abort = new AbortController()
  #loop: Promise<void> | undefined
  #longPollTimeoutMs: number
  #buffer: string | undefined
  #bufferPath: string
  #contextTokens = new Map<string, string>()
  readonly #pacer: SendPacer
  readonly #cdnBaseUrl: string

  constructor(options: TransportOptions) {
    this.#options = options
    this.#longPollTimeoutMs = options.longPollTimeoutMs ?? 35_000
    this.#bufferPath = getSyncBufFilePath(options.accountId)
    this.#pacer = new SendPacer({ minIntervalMs: options.sendIntervalMs, cooldownMs: options.sendCooldownMs })
    this.#cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
  }

  get running(): boolean {
    return this.#running
  }

  /** Latest context token seen for one conversation; iLink routes a reply by it. */
  rememberContextToken(conversationId: string, token: string): void {
    if (token !== '') this.#contextTokens.set(conversationId, token)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#loop = this.#poll().catch((error: unknown) => {
      this.#options.logger.warn(`the inbound loop stopped: ${String((error as Error)?.message ?? error)}`)
    })
  }

  async stop(): Promise<void> {
    if (!this.#running) return
    this.#running = false
    this.#abort.abort()
    await this.#loop?.catch(() => {})
    this.#loop = undefined
  }

  /**
   * One poll round, exposed so a test can step it without a background timer.
   *
   * 'retry' means the server answered but not with messages (a non-zero `ret`);
   * 'rejected' means the credential is gone and the loop should stop; 'ok'
   * includes the empty round a long poll returns on its own timeout.
   */
  async pollOnce(): Promise<'ok' | 'retry' | 'rejected' | 'stopped'> {
    // No `running` guard here: the loop owns the lifecycle, and a test steps
    // this method directly without ever starting a background loop.
    if (this.#buffer === undefined) this.#buffer = loadGetUpdatesBuf(this.#bufferPath) ?? ''
    const deadline = setTimeout(() => this.#abort.abort(), this.#longPollTimeoutMs * 2 + 10_000)
    deadline.unref?.()
    let polled: Record<string, unknown>
    try {
      polled = (await (this.#options.getUpdatesImpl ?? (getUpdates as unknown as (params: Record<string, unknown>) => Promise<Record<string, unknown>>))({
        baseUrl: this.#options.baseUrl,
        token: this.#options.token,
        get_updates_buf: this.#buffer,
        timeoutMs: this.#longPollTimeoutMs,
        abortSignal: this.#abort.signal,
      })) as Record<string, unknown>
    } catch (error) {
      this.#options.logger.warn(`getUpdates failed (${String((error as Error)?.message ?? error)})`)
      this.#abort = new AbortController()
      return 'retry'
    } finally {
      clearTimeout(deadline)
    }
    if (this.#abort.signal.aborted) {
      // A watchdog abort lands here: the vendor treats it as a normal exit.
      this.#options.logger.warn('getUpdates watchdog: one poll round overran its deadline')
      this.#abort = new AbortController()
      return 'retry'
    }
    const errcode = typeof polled['errcode'] === 'number' ? (polled['errcode'] as number) : 0
    if (errcode !== 0) {
      const rejected = new SessionRejectedError(errcode, typeof polled['errmsg'] === 'string' ? (polled['errmsg'] as string) : undefined)
      this.#options.logger.warn(rejected.message)
      this.#options.onSessionRejected(rejected.sessionExpired)
      return 'rejected'
    }
    const ret = typeof polled['ret'] === 'number' ? (polled['ret'] as number) : 0
    if (ret !== 0) {
      this.#options.logger.warn(`getUpdates ret=${ret} errmsg=${String(polled['errmsg'] ?? '(none)')}`)
      return 'retry'
    }
    const nextBuffer = polled['get_updates_buf']
    if (typeof nextBuffer === 'string' && nextBuffer !== this.#buffer) {
      this.#buffer = nextBuffer
      saveGetUpdatesBuf(this.#bufferPath, nextBuffer)
    }
    const timeout = polled['longpolling_timeout_ms']
    if (typeof timeout === 'number' && timeout > 0) this.#longPollTimeoutMs = timeout
    const messages = Array.isArray(polled['msgs']) ? (polled['msgs'] as RawMessage[]) : []
    for (const raw of messages) {
      try {
        this.#options.onMessage(raw)
      } catch (error) {
        this.#options.logger.warn(`dropped one inbound message: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return 'ok'
  }

  async #poll(): Promise<void> {
    let consecutiveFailures = 0
    while (this.#running) {
      const outcome = await this.pollOnce()
      if (outcome === 'stopped' || outcome === 'rejected') break
      if (outcome === 'ok') {
        consecutiveFailures = 0
        continue
      }
      consecutiveFailures += 1
      const wait = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? (this.#options.backoffDelayMs ?? BACKOFF_DELAY_MS)
        : (this.#options.retryDelayMs ?? RETRY_DELAY_MS)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      await sleep(wait)
    }
  }

  /** Send one text bubble. Never throws: the caller decides what a failure means. */
  async sendText(conversationId: string, text: string): Promise<SendResult> {
    if (!(await this.#pacer.take())) return { ok: false, code: 'cooling-down', retryAfterMs: 30_000 }
    const contextToken = this.#contextTokens.get(conversationId) ?? ''
    try {
      const send = (this.#options.sendImpl ?? (sendMessageItemWeixin as unknown as (params: Record<string, unknown>) => Promise<{ messageId?: string; serverMessageId?: string }>))
      const result = (await send({
        to: conversationId,
        item: { type: MessageItemType.TEXT, text_item: { text } },
        opts: {
          baseUrl: this.#options.baseUrl,
          token: this.#options.token,
          ...(contextToken === '' ? {} : { contextToken }),
        },
      })) as { messageId?: string; serverMessageId?: string }
      this.#pacer.noteSuccess()
      const serverMessageId = typeof result?.serverMessageId === 'string' ? result.serverMessageId : ''
      // "ret=0 with no message_id" is accepted-but-unconfirmed, not delivered.
      return serverMessageId === '' ? { ok: true, unconfirmed: true } : { ok: true, messageId: serverMessageId }
    } catch (error) {
      this.#pacer.noteFailure()
      const message = String((error as Error)?.message ?? error)
      return { ok: false, code: /session|token|unauthor/i.test(message) ? 'session-rejected' : 'send-failed', detail: message }
    }
  }

  /**
   * Upload and send one local file, routed by MIME type by the vendored layer
   * (image → picture bubble, video → video, else → file attachment).
   *
   * Voice outbound is deliberately absent: the server accepts a bot voice item
   * and never delivers it (measured twice on the reference implementation), so
   * audio goes out as a file.
   */
  async sendMedia(conversationId: string, filePath: string, text = ''): Promise<SendResult> {
    if (!(await this.#pacer.take())) return { ok: false, code: 'cooling-down', retryAfterMs: 30_000 }
    const contextToken = this.#contextTokens.get(conversationId) ?? ''
    try {
      const sendMedia = (this.#options.sendMediaImpl ?? (sendWeixinMediaFile as unknown as (params: Record<string, unknown>) => Promise<{ messageId?: string; serverMessageId?: string }>))
      const result = (await sendMedia({
        filePath,
        to: conversationId,
        text,
        opts: {
          baseUrl: this.#options.baseUrl,
          token: this.#options.token,
          ...(contextToken === '' ? {} : { contextToken }),
        },
        cdnBaseUrl: this.#cdnBaseUrl,
      })) as { messageId?: string; serverMessageId?: string }
      this.#pacer.noteSuccess()
      const serverMessageId = typeof result?.serverMessageId === 'string' ? result.serverMessageId : ''
      return serverMessageId === '' ? { ok: true, unconfirmed: true } : { ok: true, messageId: serverMessageId }
    } catch (error) {
      this.#pacer.noteFailure()
      const message = String((error as Error)?.message ?? error)
      return { ok: false, code: 'send-media-failed', detail: message }
    }
  }
}

/**
 * Outbound pacing.
 *
 * iLink rate-limits hard, and the reference implementation measured that
 * hammering a rejecting server is what turns a temporary rejection into a
 * send ban. So: a minimum interval between sends, and after three consecutive
 * failures a cooldown in which nothing is sent at all.
 */
export class SendPacer {
  #lastAt = 0
  #failures = 0
  #cooldownUntil = 0
  readonly #minIntervalMs: number
  readonly #cooldownMs: number
  readonly #now: () => number

  constructor({ minIntervalMs = 300, cooldownMs = 30_000, now = Date.now }: { minIntervalMs?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.#minIntervalMs = minIntervalMs
    this.#cooldownMs = cooldownMs
    this.#now = now
  }

  /** Wait until a send is allowed; resolves false when a cooldown is active. */
  async take(): Promise<boolean> {
    const now = this.#now()
    if (now < this.#cooldownUntil) return false
    const wait = this.#minIntervalMs - (now - this.#lastAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.#lastAt = this.#now()
    return true
  }

  noteSuccess(): void {
    this.#failures = 0
  }

  noteFailure(): void {
    this.#failures += 1
    if (this.#failures >= 3) {
      this.#cooldownUntil = this.#now() + this.#cooldownMs
      this.#failures = 0
    }
  }
}
