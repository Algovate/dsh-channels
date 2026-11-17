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
import { ConversationQueue } from './inbound/queue.js'
import { createRateLimiter, gateMessage, type GateContext, type GateDecision } from './inbound/gates.js'
import { allowlistFor, type ChannelsConfig } from './config.js'
import { lineKey } from './ids.js'
import { Outbox } from './store/outbox.js'
import { TurnDriver } from './turns.js'
import { plainText, splitIntoBubbles } from './outbound.js'
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
}

export class ChannelsRuntime {
  readonly #options: RuntimeOptions
  readonly #adapters = new Map<string, ChannelAdapter>()
  readonly #queue = new ConversationQueue()
  readonly #expiredAccounts = new Set<string>()
  readonly #outbox: Outbox
  readonly #driver: TurnDriver
  readonly #stopTimers: Array<() => void> = []

  constructor(options: RuntimeOptions) {
    this.#options = options
    this.#outbox = new Outbox({ stateRoot: options.stateRoot, warn: options.logger.warn })
    this.#driver = new TurnDriver({
      ctx: options.ctx,
      logger: options.logger,
      workingDirectory: options.workingDirectory,
      maxTurnWaitMs: options.config.maxTurnWaitMs,
      pollMs: options.config.turnPollMs,
      ...(options.createUserMessage === undefined ? {} : { createUserMessage: options.createUserMessage }),
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
      minute: createRateLimiter({ limit: config.senderPerMinute, windowMs: 60_000, now: () => now() }),
      day: createRateLimiter({ limit: config.senderPerDay, windowMs: 24 * 60 * 60_000, now: () => now() }),
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
    if (reply.text.trim() === '') return
    await this.send(message, { text: reply.text, kind: 'reply' })
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
      let result: SendResult
      try {
        result = await adapter.send(target, { ...outgoing, text: bubble })
      } catch (error) {
        result = { ok: false, code: 'adapter-threw', detail: String((error as Error)?.message ?? error) }
      }
      results.push(result)
      if (result.ok !== true) {
        this.#options.logger.warn(`send failed on ${target.channel} (${result.code}); keeping the reply in the outbox`)
        this.#outbox.add({ channel: target.channel, accountId: target.accountId, conversationId: target.conversationId }, { text: bubble, kind: outgoing.kind }, { code: result.code })
      }
    }
    return results
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

  /** Stop every timer this runtime started. */
  dispose(): void {
    for (const stop of this.#stopTimers.splice(0)) stop()
  }
}
