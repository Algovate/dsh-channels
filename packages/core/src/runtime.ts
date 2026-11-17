/**
 * The runtime: everything a channel needs, and nothing about any platform.
 *
 * Adapters are *registered* here (by the plugin entry point, which loads the
 * packages named in `config.adapters`) and then only ever call `dispatch()`
 * with a normalized message. The runtime decides whether the message is
 * allowed, serializes it per conversation, drives the turn and sends the reply.
 *
 * @module @derekluo/dsh-channels/runtime
 */
import fs from 'node:fs'
import path from 'node:path'

import { InteractionQueue } from './interaction/queue.js'
import { ConversationQueue } from './inbound/queue.js'
import { authorizeMessage, createDurableRateLimiter, createRateLimiter, reserveMessage, type GateContext, type GateDecision, type Reservation } from './inbound/gates.js'
import type { CounterStore } from './store/counters.js'
import { allowlistFor, type ChannelsConfig } from './config.js'
import { lineKey, sameTarget, sessionIdFor } from './ids.js'
import { helpText, parseCommand } from './commands.js'
import { Outbox } from './store/outbox.js'
import { Journal, receiptKey } from './store/journal.js'
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
  /** conversation line → session line number chosen by `/new`. */
  readonly #lines = new Map<string, number>()
  /** Built once: a limiter recreated per message would never accumulate. */
  readonly #minute: GateContext['minute']
  readonly #day: GateContext['day']
  readonly #preflightReservations = new WeakMap<InboundMessage, Reservation>()
  readonly #queuedReceipts = new Set<string>()
  #disposed = false
  readonly #stopTimers: Array<() => void> = []

  constructor(options: RuntimeOptions) {
    this.#options = options
    this.#outbox = new Outbox({ stateRoot: options.stateRoot, warn: options.logger.warn })
    this.#journal = new Journal({ stateRoot: options.stateRoot, warn: options.logger.warn })
    const counters = options.counters
    const config = options.config
    this.#minute =
      counters === undefined
        ? createRateLimiter({ limit: () => config.senderPerMinute, windowMs: 60_000 })
        : createDurableRateLimiter({ limit: () => config.senderPerMinute, windowMs: 60_000, prefix: 'minute', store: counters })
    this.#day =
      counters === undefined
        ? createRateLimiter({ limit: () => config.senderPerDay, windowMs: 24 * 60 * 60_000 })
        : createDurableRateLimiter({ limit: () => config.senderPerDay, windowMs: 24 * 60 * 60_000, prefix: 'day', store: counters })
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
  updateAllowlist(action: { add?: string; remove?: string }, persist?: (list: string[]) => boolean): string[] | undefined {
    const list = this.#options.config.allowedSenders.filter((sender) => sender !== action.remove)
    const add = typeof action.add === 'string' ? action.add.trim() : ''
    if (add !== '' && !list.includes(add)) list.push(add)
    if (persist !== undefined && !persist(list)) return undefined
    this.#options.config.allowedSenders = list
    return [...list]
  }

  /**
   * Change the settings that can take effect without a restart.
   *
   * The gates read `config` on every message, so a new limit applies to the next
   * one; the caller also writes the overlay so it survives a restart. Anything
   * that needs the adapter rebuilt (media, token, working directory) is NOT here
   * — the card marks those as restart-required instead of pretending.
   */
  updateSettings(patch: { senderPerMinute?: number; senderPerDay?: number; autoSendFiles?: boolean; questionsEnabled?: boolean; approvalsEnabled?: boolean }): void {
    const config = this.#options.config
    if (patch.senderPerMinute !== undefined) config.senderPerMinute = patch.senderPerMinute
    if (patch.senderPerDay !== undefined) config.senderPerDay = patch.senderPerDay
    if (patch.autoSendFiles !== undefined) config.autoSendFiles = patch.autoSendFiles
    if (patch.questionsEnabled !== undefined) config.questionsEnabled = patch.questionsEnabled
    if (patch.approvalsEnabled !== undefined) config.approvalsEnabled = patch.approvalsEnabled
  }

  /** The live values the settings form shows. */
  liveSettings(): { senderPerMinute: number; senderPerDay: number; autoSendFiles: boolean; questionsEnabled: boolean; approvalsEnabled: boolean } {
    const config = this.#options.config
    return {
      senderPerMinute: config.senderPerMinute,
      senderPerDay: config.senderPerDay,
      autoSendFiles: config.autoSendFiles,
      questionsEnabled: config.questionsEnabled,
      approvalsEnabled: config.approvalsEnabled,
    }
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

  gateContext(): GateContext {
    const config = this.#options.config
    return {
      expiredAccounts: this.#expiredAccounts,
      allowlistFor: (accountId) => allowlistFor(config, accountId),
      allowedChats: config.allowedChats,
      minute: this.#minute,
      day: this.#day,
      keyOf: (message) => JSON.stringify([message.channel, message.accountId, message.senderId]),
    }
  }

  #refuse(message: InboundMessage, gate: Exclude<GateDecision, { allow: true }>): GateDecision {
    this.#options.logger.info(`refused ${message.channel} message from ${message.senderId}: ${gate.reason}${gate.detail === undefined ? '' : ` (${gate.detail})`}`)
    return gate
  }

  /** Reserve quota before downloads. The adapter must dispatch the same object after enrichment. */
  canReceive(message: InboundMessage, hasAttachments = false, legacyAccountId?: string): boolean {
    if (this.#disposed) return false
    const context = this.gateContext()
    const scoped = this.#options.config.allowlistPerAccount
    if (legacyAccountId !== undefined && Object.hasOwn(scoped, legacyAccountId) && !Object.hasOwn(scoped, message.accountId)) {
      // The old override may have been narrower than the global sender list.
      context.allowlistFor = () => []
    }
    if (!this.#checkInbound(message, context).allow) return false
    // Plain replies can settle an in-flight turn even if it consumed the last slot.
    if (!hasAttachments && this.#interactions.busy(message)) return true
    if (this.#preflightReservations.has(message)) return true
    const quota = reserveMessage(message, context)
    if (!quota.allow) return this.#refuse(message, quota).allow
    this.#preflightReservations.set(message, quota.finish)
    return true
  }

  /** Release preflight quota if an adapter could not dispatch this object. */
  cancelReceive(message: InboundMessage): void {
    this.#takeReservation(message)?.(false)
  }

  #takeReservation(message: InboundMessage): Reservation | undefined {
    const reservation = this.#preflightReservations.get(message)
    this.#preflightReservations.delete(message)
    return reservation
  }

  #checkInbound(message: InboundMessage, context: GateContext): GateDecision {
    const access = authorizeMessage(message, context)
    if (!access.allow) return this.#refuse(message, access)
    const id = message.platformMessageId
    if (id !== undefined && (this.#queuedReceipts.has(receiptKey(message, id)) || this.#journal.received(message, id))) {
      return { allow: false, reason: 'duplicate' }
    }
    return access
  }

  /** Run one inbound message through the gates and, if allowed, through a turn. */
  dispatch(message: InboundMessage): GateDecision {
    if (this.#disposed) return { allow: false, reason: 'not-logged-in' }
    const context = this.gateContext()
    const access = this.#checkInbound(message, context)
    if (!access.allow) {
      this.cancelReceive(message)
      return access
    }
    const command = parseCommand(message.text)
    // Answers must bypass the queue: the running turn is waiting for them.
    const claim = command === null ? this.#interactions.claim(message, message.text) : { status: 'none' as const }
    let reservation = this.#takeReservation(message)
    if (claim.status === 'waiting' || claim.status === 'answered') {
      reservation?.(false)
      if (claim.status === 'answered') {
        this.#acceptInbound(message)
        this.#options.logger.info(`answered the pending interaction in ${lineKey(message)}`)
      }
      return access
    }
    if (reservation === undefined) {
      const quota = reserveMessage(message, context)
      if (!quota.allow) return this.#refuse(message, quota)
      reservation = quota.finish
    }
    if (claim.status === 'invalid') {
      this.#acceptInbound(message, reservation)
      void this.send(message, { text: claim.hint, kind: 'notice' })
    } else if (command !== null) {
      this.#acceptInbound(message, reservation)
      void this.#runCommand(message, command.name).catch((error: unknown) => {
        this.#options.logger.warn(`command /${command.name} failed: ${String((error as Error)?.message ?? error)}`)
      })
    } else {
      this.#enqueueTurn(message, reservation)
    }
    return access
  }

  #enqueueTurn(message: InboundMessage, reservation: Reservation): void {
    const sessionId = this.#sessionIdFor(message)
    const id = message.platformMessageId === undefined ? undefined : receiptKey(message, message.platformMessageId)
    if (id !== undefined) this.#queuedReceipts.add(id)
    let started = false
    void this.#queue
      .push(lineKey(message), async (signal) => {
        started = true
        if (id !== undefined) this.#queuedReceipts.delete(id)
        this.#acceptInbound(message, reservation)
        await this.#runTurn(message, sessionId, signal)
      })
      .catch((error: unknown) => {
        if (!started) {
          if (id !== undefined) this.#queuedReceipts.delete(id)
          reservation(false)
        }
        this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${String((error as Error)?.message ?? error)}`)
      })
  }

  #acceptInbound(message: InboundMessage, reservation?: Reservation): void {
    reservation?.(true)
    this.#journal.append({
      direction: 'in',
      phase: 'received',
      id: `in-${message.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      channel: message.channel,
      accountId: message.accountId,
      conversationId: message.conversationId,
      kind: 'message',
      ...(message.platformMessageId === undefined ? {} : { messageId: message.platformMessageId }),
      text: message.text.slice(0, 500),
      ...(message.media.length === 0 ? {} : { media: message.media.map((item) => item.path) }),
    })
  }

  /**
   * The session id this conversation is on.
   *
   * Line 0 is the deterministic id every existing conversation already uses;
   * `/new` moves the conversation to line 1, 2, … so the old session stays
   * intact (and visible in the GUI) while the next message starts clean. The
   * line is persisted in the counter store, so a restart does not walk back.
   */
  #sessionIdFor(message: InboundMessage): string {
    const key = lineKey(message)
    const stored = this.#options.counters?.get(`line:${key}`)
    const line = this.#lines.get(key) ?? (stored !== undefined && stored > 0 ? Math.floor(stored) : 0)
    if (line === 0) return sessionIdFor(message)
    return sessionIdFor({ ...message, conversationId: `${message.conversationId}#${line}` })
  }

  /** Run one chat command and answer in the chat. Never starts a turn. */
  async #runCommand(message: InboundMessage, name: 'help' | 'status' | 'whoami' | 'new'): Promise<void> {
    if (name === 'help') {
      await this.send(message, { text: helpText(), kind: 'notice' })
      return
    }
    if (name === 'whoami') {
      await this.send(message, {
        text: [
          `发送者 id：${message.senderId}`,
          `会话 id：${message.conversationId}`,
          `通道：${message.channel}（账号 ${message.accountId}）`,
          `会话线：${this.#sessionIdFor(message)}`,
        ].join('\n'),
        kind: 'notice',
      })
      return
    }
    if (name === 'status') {
      const config = this.#options.config
      const lines = [
        `通道：${[...this.#adapters.keys()].join(', ') || '（没有）'}`,
        `状态目录：${this.#options.stateRoot}`,
        `允许的发送者：${config.allowedSenders.length}`,
        `待重发：${this.#outbox.list().filter((entry) => sameTarget(entry.target, message)).length}`,
        `等待答复：${this.#interactions.busy(message) ? '有' : '无'}`,
      ]
      const recent = this.#journal.outbound(undefined, message).slice(-3)
      if (recent.length > 0) {
        lines.push('最近发出：')
        for (const entry of recent) lines.push(`· ${entry.state} ${entry.text.slice(0, 40)}`)
      }
      await this.send(message, { text: lines.join('\n'), kind: 'notice' })
      return
    }
    // `/new`: the next message goes to a fresh session, the old one stays.
    const key = lineKey(message)
    const next = (this.#lines.get(key) ?? this.#options.counters?.get(`line:${key}`) ?? 0) + 1
    this.#options.counters?.set(`line:${key}`, next)
    this.#lines.set(key, next)
    this.#options.logger.info(`${key} starts session line ${next}`)
    await this.send(message, { text: `好，这条聊天从这里开新会话（第 ${next} 条）。上一条还留在 GUI 里。`, kind: 'notice' })
  }

  /** Answer a pending interaction out of band (never queued behind its own turn). */
  async replyNow<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#queue.runNow({ run: (signal: AbortSignal) => task(signal) })
  }

  async #runTurn(message: InboundMessage, sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#disposed) return
    const adapter = this.#adapters.get(message.channel)
    if (adapter === undefined) {
      this.#options.logger.warn(`no adapter registered for channel '${message.channel}'`)
      return
    }
    if (typeof adapter.typing === 'function') void adapter.typing(message).catch(() => {})
    const startedAt = Date.now()
    const outputDir = this.#turnOutputDirectory()
    const reply = await this.#driver.run({ message, signal, sessionId, outputDirectory: outputDir })
    if (signal.aborted || this.#disposed) return
    this.#options.logger.info(`turn for ${lineKey(message)} settled in ${Date.now() - startedAt}ms (${reply.text.length} chars${reply.failed === true ? ', failed' : ''})`)
    if (reply.failed === true) {
      // The failure text is for the log, not for the person: it names host
      // internals and cannot be acted on from a phone.
      this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${reply.text}`)
      await this.send(message, { text: '（这边出了点问题，这条没答上来。稍后再发一次，或者看 /diag。）', kind: 'notice' })
      return
    }
    if (reply.text.trim() !== '') await this.send(message, { text: reply.text, kind: 'reply' })
    if (outputDir !== undefined && !this.#disposed) await this.#sendProducedFiles(message, outputDir)
  }

  /** Send one outgoing message, split to the channel's capability, with outbox fallback. */
  async send(target: Target, outgoing: Outgoing): Promise<SendResult[]> {
    if (this.#disposed) return [{ ok: false, code: 'stopped' }]
    const adapter = this.#adapters.get(target.channel)
    if (adapter === undefined) return [{ ok: false, code: 'unknown-channel', detail: target.channel }]
    const text = outgoing.text === undefined ? '' : plainText(outgoing.text)
    const limit = Number.isFinite(adapter.capabilities.maxTextChars) && adapter.capabilities.maxTextChars > 0 ? adapter.capabilities.maxTextChars : this.#options.config.maxTextChars
    const bubbles = splitIntoBubbles(text, limit)
    const results: SendResult[] = []
    const base = { kind: outgoing.kind }
    for (const [index, bubble] of bubbles.entries()) {
      if (index > 0 && this.#options.config.bubbleGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#options.config.bubbleGapMs))
      if (this.#disposed) return [...results, { ok: false, code: 'stopped' }]
      results.push(await this.#deliver(adapter, target, { ...base, text: bubble }, bubble))
    }
    for (const item of outgoing.media ?? []) {
      if (this.#disposed) return [...results, { ok: false, code: 'stopped' }]
      // Media cannot be re-sent from the outbox (it holds text), so a failure
      // is reported and journalled, not queued.
      const result = await this.#deliver(adapter, target, { kind: outgoing.kind, text: '', media: [item] }, '')
      results.push(result)
    }
    return results
  }

  #turnOutputDirectory(): string | undefined {
    if (!this.#options.config.autoSendFiles) return undefined
    try {
      const workspace = path.resolve(this.#options.workingDirectory)
      fs.mkdirSync(workspace, { recursive: true })
      return fs.mkdtempSync(path.join(workspace, '.channel-output-'))
    } catch (error) {
      this.#options.logger.warn(`could not create a turn output directory: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Send what the turn wrote. The scan is bounded, and a file that cannot go
   * out costs a log line, never the reply that already went out.
   */
  async #sendProducedFiles(message: InboundMessage, outputDir: string): Promise<void> {
    if (this.#options.config.autoSendFiles !== true) return
    let files
    try {
      files = await listProducedFiles({
        dir: outputDir,
        sinceMs: 0,
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
  async #deliver(adapter: ChannelAdapter, target: Target, outgoing: Outgoing, text: string, retryId?: string): Promise<SendResult> {
    const id = retryId ?? `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
      ...(result.ok === true ? {} : { code: result.code, id }),
    })
    if (retryId === undefined && result.ok !== true && text !== '' && outgoing.kind === 'reply') {
      this.#options.logger.warn(`send failed on ${target.channel} (${result.code}); keeping the reply in the outbox`)
      this.#outbox.add({ channel: target.channel, accountId: target.accountId, conversationId: target.conversationId }, { text, kind: outgoing.kind }, { code: result.code, id })
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
          if (this.#disposed) return { ok: false as const, code: 'stopped' }
          const accounts = await adapter.accounts.list()
          if (!accounts.some((account) => account.accountId === entry.target.accountId && !account.expired)) {
            return { ok: false as const, code: 'account-unavailable' }
          }
          if (this.#disposed || this.#adapters.get(entry.target.channel) !== adapter) return { ok: false as const, code: 'stopped' }
          const result = await this.#deliver(adapter, entry.target, entry.outgoing, entry.outgoing.text ?? '', entry.id)
          return result.ok === true ? { ok: true as const } : { ok: false as const, code: result.code }
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
    this.#disposed = true
    this.#queue.dispose()
    for (const stop of this.#stopTimers.splice(0)) stop()
    this.#interactions.dispose()
    this.#targets.clear()
  }
}
