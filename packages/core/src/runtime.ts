/**
 * The runtime: everything a channel needs, and nothing about any platform.
 *
 * Adapters are *registered* here (by the plugin entry point, which loads the
 * packages named in `config.adapters`) and then only ever call `dispatch()`
 * with a normalized message. The runtime decides whether the message is
 * allowed, serializes it per conversation, drives the turn and sends the reply.
 *
 * @module @rodin/dsh-channels/runtime
 */
import { InteractionQueue } from './interaction/queue.js'
import { ConversationQueue } from './inbound/queue.js'
import { createDurableRateLimiter, createRateLimiter, gateMessage, type GateContext, type GateDecision } from './inbound/gates.js'
import type { CounterStore } from './store/counters.js'
import { allowlistFor, type ChannelsConfig } from './config.js'
import { lineKey } from './ids.js'
import { Outbox } from './store/outbox.js'
import { Journal } from './store/journal.js'
import { TurnDriver } from './turns.js'
import { plainText, splitIntoBubbles } from './outbound.js'
import { listProducedFiles } from './produced.js'
import type { ChannelAdapter, InboundMessage, Outgoing, SendResult, Target } from './types.js'

export interface RuntimeLogger {
  info: (line: string) => void
  warn: (line: string) => void
}

export interface RuntimeOptions {
  ctx: { get?: (name: string) => unknown }
  config: ChannelsConfig
  logger: RuntimeLogger
  stateRoot: string
  workingDirectory: string
  createUserMessage?: (fields: Record<string, unknown>) => unknown
  now?: () => number
  /** Put a channel session in the host's workspace grouping (once per session). */
  attachToWorkspace?: (sessionId: string) => void
  /** Durable rate counters; without one the gates count in memory only. */
  counters?: CounterStore
}

export class ChannelsRuntime {
  readonly #options: RuntimeOptions
  readonly #adapters = new Map<string, ChannelAdapter>()
  readonly #queue = new ConversationQueue()
  readonly #expiredAccounts = new Set<string>()
  readonly #outbox: Outbox
  readonly #journal: Journal
  readonly #driver: TurnDriver
  readonly #interactions: InteractionQueue
  /** session id → the conversation it answers for; the interaction seams need it. */
  readonly #targets = new Map<string, Target>()
  /** Sessions already reported to the host's workspace grouping. */
  readonly #grouped = new Set<string>()
  readonly #stopTimers: Array<() => void> = []

  constructor(options: RuntimeOptions) {
    this.#options = options
    this.#outbox = new Outbox({ stateRoot: options.stateRoot, warn: options.logger.warn })
    this.#journal = new Journal({ stateRoot: options.stateRoot, warn: options.logger.warn })
    this.#interactions = new InteractionQueue({
      send: (target, outgoing) => this.send(target, outgoing),
      logger: options.logger,
      timeoutMs: () => options.config.interactionTimeoutMs,
    })
    this.#driver = new TurnDriver({
      ctx: options.ctx,
      logger: options.logger,
      workingDirectory: options.workingDirectory,
      maxTurnWaitMs: options.config.maxTurnWaitMs,
      pollMs: options.config.turnPollMs,
      ...(options.createUserMessage === undefined ? {} : { createUserMessage: options.createUserMessage }),
      // The GUI lists titled sessions; `<sender>: <first words>` reads the way
      // the reference implementation's titles did on the phone.
      titleFor: (message) => {
        const who = message.senderId.split('@')[0] ?? message.senderId
        const words = message.text.trim().replace(/\s+/g, ' ').slice(0, 24)
        if (words === '') return `${who}（${message.media.length} 个附件）`
        return `${who.slice(0, 12)}: ${words}`
      },
      onAttach: (target, sessionId) => {
        if (!this.#grouped.has(sessionId)) {
          this.#grouped.add(sessionId)
          try {
            this.#options.attachToWorkspace?.(sessionId)
          } catch {
            // Grouping is cosmetic; a callback cannot fail a turn.
          }
        }
        // Keep only the addressing fields: a Target is what the seams need, and
        // holding the whole message would keep its text (and media paths) alive.
        this.#targets.set(sessionId, {
          channel: target.channel,
          accountId: target.accountId,
          conversationId: target.conversationId,
        })
      },
    })
  }

  get logger(): RuntimeLogger {
    return this.#options.logger
  }

  get config(): ChannelsConfig {
    return this.#options.config
  }

  get outbox(): Outbox {
    return this.#outbox
  }

  get journal(): Journal {
    return this.#journal
  }

  get interactions(): InteractionQueue {
    return this.#interactions
  }

  /**
   * The conversation an agent answers for, when it answers for one.
   *
   * `undefined` means "not this channel's business" — a session created in the
   * desktop UI, or a side session — so the desktop answerer stays in charge.
   */
  targetForAgent(agent: unknown): Target | undefined {
    const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return this.#targets.get(sessionId)
  }

  /**
   * Add or remove one sender in the live allowlist.
   *
   * The gate reads `config.allowedSenders` on every message, so mutating it here
   * takes effect for the next message without a restart; the caller persists the
   * overlay so it survives one.
   */
  updateAllowlist(action: { add?: string; remove?: string }): string[] {
    const list = this.#options.config.allowedSenders
    if (typeof action.remove === 'string' && action.remove !== '') {
      const index = list.indexOf(action.remove)
      if (index >= 0) list.splice(index, 1)
    }
    const add = typeof action.add === 'string' ? action.add.trim() : ''
    if (add !== '' && !list.includes(add)) list.push(add)
    return [...list]
  }

  /** Forget a conversation (tests, or after the adapter is removed). */
  forgetTarget(sessionId: string): void {
    this.#targets.delete(sessionId)
  }

  register(adapter: ChannelAdapter): () => void {
    if (this.#adapters.has(adapter.id)) return () => {}
    this.#adapters.set(adapter.id, adapter)
    this.#options.logger.info(`channel '${adapter.id}' registered`)
    return () => {
      this.#adapters.delete(adapter.id)
    }
  }

  adapters(): ChannelAdapter[] {
    return [...this.#adapters.values()]
  }

  adapter(id: string): ChannelAdapter | undefined {
    return this.#adapters.get(id)
  }

  /** Mark one account's credential expired; the gate then refuses it. */
  markExpired(accountId: string, expired = true): void {
    if (expired) this.#expiredAccounts.add(accountId)
    else this.#expiredAccounts.delete(accountId)
  }

  gateContext(now = Date.now): GateContext {
    const config = this.#options.config
    return {
      expiredAccounts: this.#expiredAccounts,
      allowlistFor: (accountId) => allowlistFor(config, accountId),
      allowedChats: config.allowedChats,
      minute:
        this.#options.counters === undefined
          ? createRateLimiter({ limit: config.senderPerMinute, windowMs: 60_000, now: () => now() })
          : createDurableRateLimiter({ limit: config.senderPerMinute, windowMs: 60_000, prefix: 'minute', store: this.#options.counters, now: () => now() }),
      day:
        this.#options.counters === undefined
          ? createRateLimiter({ limit: config.senderPerDay, windowMs: 24 * 60 * 60_000, now: () => now() })
          : createDurableRateLimiter({ limit: config.senderPerDay, windowMs: 24 * 60 * 60_000, prefix: 'day', store: this.#options.counters, now: () => now() }),
      keyOf: (message) => lineKey(message),
    }
  }

  /** Run one inbound message through the gates and, if allowed, through a turn. */
  dispatch(message: InboundMessage): GateDecision {
    const gate = gateMessage(message, this.gateContext())
    if (gate.allow !== true) {
      this.#options.logger.info(`refused ${message.channel} message from ${message.senderId}: ${gate.reason}${gate.detail === undefined ? '' : ` (${gate.detail})`}`)
      return gate
    }
    // A reply to an open question or approval is consumed here, before the turn
    // queue: queueing it behind the very turn that is asking deadlocks until the
    // timeout. The gate above still applies — a stranger cannot answer for you.
    this.#journal.append({
      direction: 'in',
      phase: 'received',
      id: `in-${message.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      channel: message.channel,
      accountId: message.accountId,
      conversationId: message.conversationId,
      kind: 'message',
      text: message.text.slice(0, 500),
      ...(message.media.length === 0 ? {} : { media: message.media.map((item) => item.path) }),
    })
    const claim = this.#interactions.claim(message, message.text)
    if (claim.status === 'answered') {
      this.#options.logger.info(`answered the pending interaction in ${lineKey(message)}`)
      return gate
    }
    if (claim.status === 'invalid') {
      void this.send(message, { text: claim.hint, kind: 'notice' })
      return gate
    }
    void this.#queue
      .push(lineKey(message), { run: (signal: AbortSignal) => this.#runTurn(message, signal) })
      .catch((error: unknown) => {
        this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${String((error as Error)?.message ?? error)}`)
      })
    return gate
  }

  /** Answer a pending interaction out of band (never queued behind its own turn). */
  async replyNow<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#queue.runNow({ run: (signal: AbortSignal) => task(signal) })
  }

  async #runTurn(message: InboundMessage, signal: AbortSignal): Promise<void> {
    const adapter = this.#adapters.get(message.channel)
    if (adapter === undefined) {
      this.#options.logger.warn(`no adapter registered for channel '${message.channel}'`)
      return
    }
    if (typeof adapter.typing === 'function') void adapter.typing(message).catch(() => {})
    const startedAt = Date.now()
    const reply = await this.#driver.run({ message, signal })
    this.#options.logger.info(`turn for ${lineKey(message)} settled in ${Date.now() - startedAt}ms (${reply.text.length} chars${reply.failed === true ? ', failed' : ''})`)
    if (reply.failed === true) {
      // The failure text is for the log, not for the person: it names host
      // internals and cannot be acted on from a phone.
      this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${reply.text}`)
      await this.send(message, { text: '（这边出了点问题，这条没答上来。稍后再发一次，或者看 /diag。）', kind: 'notice' })
      return
    }
    if (reply.text.trim() !== '') await this.send(message, { text: reply.text, kind: 'reply' })
    await this.#sendProducedFiles(message, startedAt)
  }

  /** Send one outgoing message, split to the channel's capability, with outbox fallback. */
  async send(target: Target, outgoing: Outgoing): Promise<SendResult[]> {
    const adapter = this.#adapters.get(target.channel)
    if (adapter === undefined) return [{ ok: false, code: 'unknown-channel', detail: target.channel }]
    const text = outgoing.text === undefined ? '' : plainText(outgoing.text)
    const limit = Number.isFinite(adapter.capabilities.maxTextChars) && adapter.capabilities.maxTextChars > 0 ? adapter.capabilities.maxTextChars : this.#options.config.maxTextChars
    const bubbles = splitIntoBubbles(text, limit)
    const results: SendResult[] = []
    for (const [index, bubble] of bubbles.entries()) {
      if (index > 0 && this.#options.config.bubbleGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#options.config.bubbleGapMs))
      results.push(await this.#deliver(adapter, target, { ...outgoing, text: bubble }, bubble))
    }
    for (const item of outgoing.media ?? []) {
      // Media cannot be re-sent from the outbox (it holds text), so a failure
      // is reported and journalled, not queued.
      const result = await this.#deliver(adapter, target, { kind: outgoing.kind, text: '', media: [item] }, '')
      results.push(result)
    }
    return results
  }

  /**
   * Send what the turn wrote. The scan is bounded, and a file that cannot go
   * out costs a log line, never the reply that already went out.
   */
  async #sendProducedFiles(message: InboundMessage, sinceMs: number): Promise<void> {
    if (this.#options.config.autoSendFiles !== true) return
    let files
    try {
      files = await listProducedFiles({
        dir: this.#options.workingDirectory,
        sinceMs,
        maxFiles: this.#options.config.maxProducedFiles,
        maxBytes: this.#options.config.maxProducedBytes,
      })
    } catch (error) {
      this.#options.logger.warn(`scanning produced files failed: ${String((error as Error)?.message ?? error)}`)
      return
    }
    if (files.length === 0) return
    const media = files
      .filter((file) => file.bytes > 0)
      .map((file) => ({ kind: 'file' as const, path: file.path, name: file.name, bytes: file.bytes }))
    if (media.length === 0) return
    this.#options.logger.info(`sending ${media.length} produced file(s)`)
    await this.send(message, { kind: 'reply', media })
  }

  /** One send, journalled in two phases. */
  async #deliver(adapter: ChannelAdapter, target: Target, outgoing: Outgoing, text: string): Promise<SendResult> {
    const id = `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const media = (outgoing.media ?? []).map((item) => item.path)
    const base = {
      direction: 'out' as const,
      id,
      channel: target.channel,
      accountId: target.accountId,
      conversationId: target.conversationId,
      kind: outgoing.kind,
      text: text.slice(0, 500),
      ...(media.length === 0 ? {} : { media }),
    }
    this.#journal.append({ ...base, phase: 'sending' })
    let result: SendResult
    try {
      result = await adapter.send(target, outgoing)
    } catch (error) {
      result = { ok: false, code: 'adapter-threw', detail: String((error as Error)?.message ?? error) }
    }
    this.#journal.append({
      ...base,
      phase: 'settled',
      delivery: result.ok === true ? (result.unconfirmed === true ? 'unconfirmed' : 'accepted') : 'failed',
      ...(result.ok === true && result.messageId !== undefined ? { messageId: result.messageId } : {}),
      ...(result.ok === true ? {} : { code: result.code }),
    })
    if (result.ok !== true && text !== '') {
      this.#options.logger.warn(`send failed on ${target.channel} (${result.code}); keeping the reply in the outbox`)
      this.#outbox.add({ channel: target.channel, accountId: target.accountId, conversationId: target.conversationId }, { text, kind: outgoing.kind }, { code: result.code })
    }
    return result
  }

  /** Start a periodic outbox retry; returns the stop function. */
  startOutboxRetry(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.#outbox
        .drain(async (entry) => {
          const adapter = this.#adapters.get(entry.target.channel)
          if (adapter === undefined) return { ok: false as const, code: 'unknown-channel' }
          try {
            const result = await adapter.send(entry.target, { text: entry.outgoing.text ?? '', kind: entry.outgoing.kind })
            return result.ok === true ? { ok: true as const } : { ok: false as const, code: result.code }
          } catch (error) {
            return { ok: false as const, code: 'adapter-threw' }
          }
        })
        .catch((error: unknown) => this.#options.logger.warn(`outbox retry failed: ${String(error)}`))
    }, intervalMs)
    timer.unref?.()
    const stop = (): void => clearInterval(timer)
    this.#stopTimers.push(stop)
    return stop
  }

  /** Stop every timer this runtime started, and reject every pending interaction. */
  dispose(): void {
    for (const stop of this.#stopTimers.splice(0)) stop()
    this.#interactions.dispose()
    this.#targets.clear()
  }
}
