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

import { answerArtifactCommand, type ArtifactDelivery } from './artifacts.js'
import { applyLiveSettings, liveSettings, type LiveSettings, type LiveSettingsPatch } from './live-settings.js'
import { InteractionQueue } from './interaction/queue.js'
import { isApprovalReply } from './interaction/approval.js'
import { ConversationQueue } from './inbound/queue.js'
import { authorizeMessage, createDurableRateLimiter, createRateLimiter, reserveMessage, type GateContext, type GateDecision, type Reservation } from './inbound/gates.js'
import type { CounterStore } from './store/counters.js'
import { allowlistFor, type ChannelsConfig } from './config.js'
import { lineKey, sameTarget } from './ids.js'
import { helpText, parseCommand, TASK_CONTROLS, type CommandName } from './commands.js'
import { ChannelSchedules } from './schedules.js'
import { ChannelRoutes } from './routing.js'
import { Inbox, type InboxEntry } from './store/inbox.js'
import type { Outbox } from './store/outbox.js'
import { Delivery } from './delivery.js'
import { Tasks, type TaskRecord } from './store/tasks.js'
import { Pairings, type PairingRequest } from './store/pairings.js'
import { Journal } from './store/journal.js'
import { TurnDriver, type TurnReply } from './turns.js'
import type { HostContext } from './host.js'
import { chatParagraphs } from './outbound.js'
import { prepareTaskArtifacts } from './task-artifacts.js'
import { taskHistoryText, taskStatusText } from './task-messages.js'
import type { ChannelAdapter, InboundMessage, IngressSink, Outgoing, SendResult, Target } from './types.js'
import { setTimeout as delay } from 'node:timers/promises'

export interface RuntimeLogger {
  info: (line: string) => void
  warn: (line: string) => void
}

export interface RuntimeOptions {
  ctx: HostContext
  config: ChannelsConfig
  logger: RuntimeLogger
  stateRoot: string
  workingDirectory: string
  createUserMessage?: (fields: Record<string, unknown>) => unknown
  /** Put a channel session in the host's workspace grouping (once per session). */
  attachToWorkspace?: (sessionId: string, workingDirectory?: string) => void
  /** Durable rate counters; without one the gates count in memory only. */
  counters?: CounterStore
}

export class ChannelsRuntime {
  readonly #options: RuntimeOptions
  readonly #adapters = new Map<string, ChannelAdapter>()
  readonly #queue = new ConversationQueue()
  readonly #expiredAccounts = new Set<string>()
  readonly #inbox: Inbox
  readonly #queuedInputs = new Map<string, { scheduled: boolean; finish?: Reservation; blocked?: boolean; card?: { messageId: string }; receipt?: Promise<void> }>()
  readonly #activeTasks = new Map<string, { record: TaskRecord; controller: AbortController }>()
  readonly #tasks: Tasks
  readonly #pairings: Pairings
  #resuming = false
  readonly #delivery: Delivery
  readonly #journal: Journal
  readonly #driver: TurnDriver
  readonly #interactions: InteractionQueue
  /** Sessions already reported to the host's workspace grouping. */
  readonly #grouped = new Set<string>()
  /** All project authorization and session identity decisions. */
  readonly #schedules: ChannelSchedules
  readonly #routes: ChannelRoutes
  readonly #routeNotices = new Set<string>()
  /** Built once: a limiter recreated per message would never accumulate. */
  readonly #minute: GateContext['minute']
  readonly #day: GateContext['day']
  readonly #preflightReservations = new WeakMap<InboundMessage, Reservation>()
  #disposed = false
  readonly #stopTimers: Array<() => void> = []
  /** Per-chat durable handoff chain; priority controls bypass it. */
  readonly #ingressTails = new Map<string, Promise<void>>()
  readonly #ingressStop = new AbortController()

  constructor(options: RuntimeOptions) {
    this.#options = options
    this.#routes = new ChannelRoutes(options)
    this.#inbox = new Inbox(options.stateRoot, options.logger.warn)
    this.#tasks = new Tasks(options.stateRoot, options.logger.warn)
    this.#pairings = new Pairings(options.stateRoot, options.logger.warn)
    this.#journal = new Journal({ stateRoot: options.stateRoot, warn: options.logger.warn })
    this.#delivery = new Delivery({
      config: options.config, logger: options.logger, stateRoot: options.stateRoot,
      adapters: this.#adapters, tasks: this.#tasks, routes: this.#routes, journal: this.#journal,
      authorized: (message) => authorizeMessage(message, this.gateContext()).allow,
      canDeliverSchedule: (id, target) => this.#schedules.canDeliver(id, target),
    })
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
      onAttach: (_target, sessionId, workingDirectory) => {
        if (!this.#grouped.has(sessionId)) {
          this.#grouped.add(sessionId)
          try {
            this.#options.attachToWorkspace?.(sessionId, workingDirectory)
          } catch {
            // Grouping is cosmetic; a callback cannot fail a turn.
          }
        }

      },
    })
    this.#schedules = new ChannelSchedules({
      ctx: options.ctx, stateRoot: options.stateRoot, logger: options.logger,
      route: (message) => this.#routes.snapshot(message),
      attach: async (message, sessionId, workingDirectory) => { await this.#driver.attach(message, { sessionId, workingDirectory }) },
      canManage: async (message) => this.canManage(message) && await this.#scheduleAccess(message),
      authorized: async (binding) => {
        const projectAvailable = () => {
          if (!this.#routes.acceptsQueued({ id: binding.id, message: binding.message, sessionId: binding.sessionId, project: binding.project, workingDirectory: binding.workingDirectory })) return false
          try { return fs.statSync(binding.workingDirectory).isDirectory() } catch { return false }
        }
        // Check once after the async permission read: project removal during the
        // await must still revoke delivery.
        return await this.#scheduleAccess(binding.message) && projectAvailable()
      },
      send: async (message, text, deliveryId) => {
        if (deliveryId) this.#adapters.get(message.channel)?.restoreInbound?.(message)
        return this.send(message, { kind: deliveryId ? 'reply' : 'notice', text }, deliveryId)
      },
      queued: (id) => this.#delivery.outbox.list().some((entry) => entry.taskId === id),
    })
  }

  async #scheduleAccess(message: InboundMessage): Promise<boolean> {
    const allowed = () => !this.#disposed && authorizeMessage(message, this.gateContext()).allow
    if (!allowed()) return false
    const adapter = this.#adapters.get(message.channel)
    if (!adapter) return false
    try {
      const accounts = await adapter.accounts.list()
      return allowed() && this.#adapters.get(message.channel) === adapter && accounts.some((account) => account.accountId === message.accountId && !account.expired)
    } catch { return false }
  }

  get logger(): RuntimeLogger {
    return this.#options.logger
  }

  get config(): ChannelsConfig {
    return this.#options.config
  }

  get outbox(): Outbox {
    return this.#delivery.outbox
  }

  pendingInputs(target?: Target): number {
    return this.#inbox.list().filter((entry) => target === undefined || sameTarget(entry.message, target)).length
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
  interactionForAgent(agent: unknown): ReturnType<TurnDriver['interactionForAgent']> {
    return this.#driver.interactionForAgent(agent)
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
  updateSettings(patch: LiveSettingsPatch): void {
    applyLiveSettings(this.config, patch)
  }

  /** The live values the settings form shows. */
  liveSettings(): LiveSettings {
    return liveSettings(this.config)
  }

  /** The durable ingress sink handed to drivers that support it. */
  ingress(): IngressSink {
    return { offer: (message, options) => this.offer(message, options) }
  }

  /**
   * Accept one driver message through the core's durable handoff.
   *
   * The per-chat chain keeps ordinary messages in order; a control or
   * interaction reply may bypass it. A `DSH_INBOUND_RETRY` handoff is retried
   * here, so the driver does not need its own retry loop.
   */
  async offer(message: InboundMessage, options: { priority?: boolean } = {}): Promise<void> {
    const deliver = async (): Promise<void> => {
      for (;;) {
        if (this.#disposed) throw Object.assign(new Error('the channel runtime is disposed'), { code: 'DSH_INBOUND_RETRY' })
        try {
          this.dispatch(message)
          return
        } catch (error) {
          if ((error as { code?: string } | null)?.code !== 'DSH_INBOUND_RETRY') {
            this.logger.warn(`inbound handler failed: ${String((error as Error)?.message ?? error)}`)
            return
          }
          this.logger.warn(`inbound handoff will retry: ${String((error as Error)?.message ?? error)}`)
          try {
            await delay(3_000, undefined, { signal: this.#ingressStop.signal })
          } catch {
            this.#ingressStop.signal.throwIfAborted()
          }
        }
      }
    }
    if (options.priority === true) return deliver()
    const key = lineKey(message)
    const previous = this.#ingressTails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(deliver)
    this.#ingressTails.set(key, next)
    try {
      await next
    } finally {
      if (this.#ingressTails.get(key) === next) this.#ingressTails.delete(key)
    }
  }

  register(adapter: ChannelAdapter): () => void {
    if (this.#adapters.has(adapter.id)) throw new Error(`duplicate channel id: ${adapter.id}`)
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

  /** Unknown senders become a pending request for the desktop card, not a log hunt. */
  #requestPairing(message: InboundMessage): void {
    try {
      const result = this.#pairings.request(message)
      if (!result.notice) return
      this.logger.info(`pairing requested from ${message.senderId} (${lineKey(message)})`)
      void this.send(message, {
        kind: 'notice',
        text: '消息已收到，但发送者尚未获准。请在 DSH 的通道状态卡片批准后重新发送。',
      }).catch((error: unknown) => this.logger.warn(`pairing notice failed: ${String(error)}`))
    } catch (error) {
      this.logger.warn(`pairing request could not be recorded: ${String(error)}`)
    }
  }

  /** Owners may change shared routing and manage schedules; empty owners means everyone. */
  canManage(message: InboundMessage): boolean {
    const owners = this.#options.config.owners
    return owners.length === 0 || owners.includes(message.senderId)
  }

  /** Pending admission requests, already scoped to this runtime. */
  pendingPairings(): readonly PairingRequest[] {
    return this.#pairings.list()
  }

  /**
   * Approve or deny one pending sender. Persistence runs before the live
   * allowlist changes, so a failed overlay write cannot widen access.
   */
  resolvePairing(
    id: string,
    action: 'approve' | 'deny',
    persist?: (patch: { allowedSenders?: string[]; allowlistPerAccount?: Record<string, string[]> }) => boolean,
  ): { ok: true; senderId: string } | undefined {
    const pairing = this.#pairings.get(id)
    if (pairing === undefined) return undefined
    if (action === 'deny') {
      if (!this.#pairings.remove(id)) return undefined
      return { ok: true, senderId: pairing.senderId }
    }
    const config = this.#options.config
    const scoped = Object.hasOwn(config.allowlistPerAccount, pairing.accountId)
    let patch: { allowedSenders?: string[]; allowlistPerAccount?: Record<string, string[]> }
    let list: string[]
    if (scoped) {
      list = [...(config.allowlistPerAccount[pairing.accountId] ?? [])]
      if (!list.includes(pairing.senderId)) list.push(pairing.senderId)
      patch = { allowlistPerAccount: { ...config.allowlistPerAccount, [pairing.accountId]: list } }
    } else {
      list = [...config.allowedSenders]
      if (!list.includes(pairing.senderId)) list.push(pairing.senderId)
      patch = { allowedSenders: list }
    }
    if (persist !== undefined && !persist(patch)) return undefined
    if (scoped) config.allowlistPerAccount[pairing.accountId] = list
    else config.allowedSenders = list
    this.#pairings.remove(id)
    void this.send(pairing, { kind: 'notice', text: '发送者已获准使用此通道。请重新发送刚才的消息。' })
      .catch((error: unknown) => this.logger.warn(`pairing approval notice failed: ${String(error)}`))
    return { ok: true, senderId: pairing.senderId }
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

  /** Classification only. Adapters still call canReceive before handing off priority text. */
  canBypassInbound(message: InboundMessage): boolean {
    const group = this.#groupText(message)
    if (!group.addressed) return false
    const text = group.text
    const command = parseCommand(text)
    return (command !== null && TASK_CONTROLS.has(command.name)) || isApprovalReply(text) || this.#interactions.busy(message)
  }

  /**
   * Group addressing: `all` keeps the old behavior; `prefix` requires the
   * configured prefix; `mention` accepts the prefix or the configured bot
   * handle. Either is stripped before command parsing or the turn. An active
   * interaction may be answered without addressing the bot.
   */
  #groupText(message: InboundMessage): { addressed: boolean; text: string } {
    const config = this.#options.config
    if (!message.group || config.groupTrigger === 'all') return { addressed: true, text: message.text }
    const raw = message.text.trimStart()
    const prefix = config.groupPrefix
    if (raw === prefix || raw.startsWith(`${prefix} `) || raw.startsWith(`${prefix}\n`) || raw.startsWith(`${prefix}\t`)) {
      return { addressed: true, text: raw.slice(prefix.length).trimStart() }
    }
    if (config.groupTrigger === 'mention' && config.groupMention !== '') {
      const mention = config.groupMention
      if (raw.toLowerCase().startsWith(mention.toLowerCase())) {
        const rest = raw.slice(mention.length)
        if (rest === '' || /^[\s,，:：]/.test(rest)) return { addressed: true, text: rest.trimStart() }
      }
    }
    return { addressed: this.#interactions.busy(message), text: message.text }
  }

  /**
   * Reserve quota before downloads. The adapter must dispatch the same object
   * after enrichment. Also records an unknown sender's pairing request and
   * messages them, so a refused preflight still explains itself.
   */
  canReceive(message: InboundMessage, hasAttachments = false, legacyAccountId?: string): boolean {
    if (this.#disposed) return false
    const group = this.#groupText(message)
    if (!group.addressed) return this.#refuse(message, { allow: false, reason: 'not-addressed' }).allow
    const context = this.gateContext()
    const scoped = this.#options.config.allowlistPerAccount
    if (legacyAccountId !== undefined && Object.hasOwn(scoped, legacyAccountId) && !Object.hasOwn(scoped, message.accountId)) {
      // The old override may have been narrower than the global sender list.
      context.allowlistFor = () => []
    }
    const check = this.#checkInbound(message, context)
    if (!check.allow) {
      if (check.reason === 'not-allowed') this.#requestPairing(message)
      return false
    }
    // `dispatch` strips the group prefix later; preflight must parse the same
    // text or `/ask /cancel` misses the control-command bypass.
    const command = parseCommand(group.text)
    if (!hasAttachments && (isApprovalReply(group.text) || (command !== null && TASK_CONTROLS.has(command.name)))) return true
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
    if (id !== undefined && (this.#inbox.contains(message) || this.#journal.received(message, id))) {
      return { allow: false, reason: 'duplicate' }
    }
    return access
  }

  /** Run one inbound message through the gates and, if allowed, through a turn. */
  dispatch(message: InboundMessage): GateDecision {
    if (this.#disposed) return { allow: false, reason: 'not-logged-in' }
    const group = this.#groupText(message)
    if (!group.addressed) return this.#refuse(message, { allow: false, reason: 'not-addressed' })
    if (group.text !== message.text) message.text = group.text
    const context = this.gateContext()
    const access = this.#checkInbound(message, context)
    if (!access.allow) {
      this.cancelReceive(message)
      if (access.reason === 'not-allowed') this.#requestPairing(message)
      return access
    }
    if (message.attachmentErrors?.length && message.text.trim() === '' && message.media.length === 0) {
      this.cancelReceive(message)
      this.#acceptInbound(message)
      void this.send(message, { kind: 'notice', text: chatParagraphs('附件未能接收，本次未启动任务。请重新发送。', ...message.attachmentErrors) }).catch((error) => this.logger.warn(String(error)))
      return access
    }
    const command = parseCommand(message.text)
    // Answers must bypass the queue: the running turn is waiting for them.
    const approvalReply = isApprovalReply(message.text)
    const claim = command === null && (!approvalReply || this.#interactions.active(message) === 'approval')
      ? this.#interactions.claim(message, message.text)
      : { status: 'none' as const }
    let reservation = this.#takeReservation(message)
    if (approvalReply && (claim.status === 'none' || claim.status === 'invalid')) {
      reservation?.(false)
      this.#acceptInbound(message)
      const text = claim.status === 'invalid' ? claim.hint : '审批已失效。请使用最新审批提示中的验证码。'
      void this.send(message, { text, kind: 'notice' })
      return access
    }
    if (claim.status === 'waiting' || claim.status === 'answered') {
      reservation?.(false)
      if (claim.status === 'answered') {
        this.#acceptInbound(message)
        this.#options.logger.info(`answered the pending interaction in ${lineKey(message)}`)
      }
      return access
    }
    if (command !== null && TASK_CONTROLS.has(command.name)) {
      reservation?.(false)
      this.#acceptInbound(message)
      void this.#runCommand(message, command.name, command.args).catch((error: unknown) => this.logger.warn(`command /${command.name} failed: ${String(error)}`))
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
      void this.#runCommand(message, command.name, command.args).catch((error: unknown) => {
        this.#options.logger.warn(`command /${command.name} failed: ${String((error as Error)?.message ?? error)}`)
      })
    } else {
      this.#enqueueTurn(message, reservation)
    }
    return access
  }

  syncSchedules(): Promise<void> { return this.#schedules.sync() }

  /** Schedule saved work only after its channel has started; retry quota waits periodically. */
  async resumePending(): Promise<void> {
    if (this.#disposed || this.#resuming) return
    this.#resuming = true
    try {
      await this.#recoverTasks()
      for (const entry of this.#inbox.list()) {
        if (this.#queuedInputs.get(entry.id)?.scheduled === true) continue
        const adapter = this.#adapters.get(entry.message.channel)
        if (adapter === undefined) continue
        try {
          const accounts = await adapter.accounts.list()
          if (this.#disposed) return
          if (!accounts.some((account) => account.accountId === entry.message.accountId && !account.expired)) continue
          const access = authorizeMessage(entry.message, this.gateContext())
          if (!access.allow) { this.#inbox.remove(entry.id); continue }
          const quota = reserveMessage(entry.message, this.gateContext())
          if (!quota.allow) continue
          try { adapter.restoreInbound?.(entry.message) }
          catch (error) { quota.finish(false); throw error }
          this.#enqueueTurn(entry.message, quota.finish, entry)
        } catch (error) { this.logger.warn(`queued input could not resume: ${String(error)}`) }
      }
    } finally { this.#resuming = false }
    await this.#schedules.sync().catch((error) => this.logger.warn(`schedule recovery failed: ${String(error)}`))
  }

  async #recoverTasks(): Promise<void> {
    for (const record of this.#tasks.recoverable()) {
      if (this.#disposed) return
      const recovery = record.recovery!
      if (this.#queuedInputs.get(record.id)?.scheduled || this.#activeTasks.get(lineKey(record.target))?.record.id === record.id) continue
      const message = recovery.message
      const allowed = async () => sameTarget(record.target, message) && record.senderId === message.senderId
        && this.#routes.acceptsQueued({ id: record.id, message, sessionId: recovery.sessionId, project: recovery.project, workingDirectory: record.workingDirectory })
        && await this.#scheduleAccess(message)
        && this.#routes.acceptsQueued({ id: record.id, message, sessionId: recovery.sessionId, project: recovery.project, workingDirectory: record.workingDirectory })
      try {
        if (!await allowed()) continue
        const result = await this.#driver.recover(recovery, record.workingDirectory ?? this.#options.workingDirectory,
          AbortSignal.any([this.#ingressStop.signal, AbortSignal.timeout(10000)]), recovery.cursor)
        if (!await allowed()) continue
        if (!result.reply) {
          this.#tasks.update(message, record.id, { execution: 'unknown', recovery: { ...recovery, cursor: result.cursor } })
          continue
        }
        this.#adapters.get(message.channel)?.restoreInbound?.(message)
        await this.#finishTurn(message, record, result.reply)
      } catch (error) { this.logger.warn(`task result recovery failed for ${record.id}: ${String(error)}`) }
    }
  }

  #enqueueTurn(message: InboundMessage, reservation: Reservation, saved?: InboxEntry): void {
    let entry: InboxEntry
    try {
      if (saved !== undefined) entry = saved
      else {
        const route = this.#routes.snapshot(message)
        entry = this.#inbox.add(message, route.sessionId, route.workingDirectory, route.project)
      }
      this.#routeNotices.delete(lineKey(message))
    }
    catch (error) {
      reservation(false)
      const key = lineKey(message)
      if (!this.#routeNotices.has(key)) {
        this.#routeNotices.add(key)
        void this.send(message, { kind: 'notice', text: '消息暂未接收，平台将重试。请在 DSH 检查项目和状态目录；项目已移除时可用 /project default 返回默认项目。' }).catch((error) => this.logger.warn(String(error)))
      }
      throw Object.assign(new Error(`inbound handoff failed: ${String(error)}`), { code: 'DSH_INBOUND_RETRY' })
    }
    const queued = this.#queuedInputs.get(entry.id) ?? { scheduled: false }
    queued.scheduled = true
    queued.finish = reservation
    this.#queuedInputs.set(entry.id, queued)
    if (saved === undefined) {
      const ahead = this.pendingInputs(message) - 1 + (this.#activeTasks.has(lineKey(message)) ? 1 : 0)
      queued.receipt = this.send(message, { text: ahead > 0 ? `已接收，前面有 ${ahead} 个任务。发 /status 查看队列。` : '已接收，准备处理。', kind: 'notice' })
        .then((results) => {
          const hit = results.find((result) => result.ok)
          const id = hit?.ok === true ? hit.messageId : undefined
          if (id !== undefined && this.#adapters.get(message.channel)?.capabilities.edit === true) queued.card = { messageId: id }
        })
        .catch((error) => this.logger.warn(`receipt notice failed: ${String(error)}`))
    }
    let charged = false
    void this.#queue
      .push(lineKey(message), async (signal) => {
        if (signal.aborted || this.#disposed || !this.#adapters.has(message.channel)) return
        if (!this.#inbox.list().some((item) => item.id === entry.id)) return
        const access = authorizeMessage(message, this.gateContext())
        if (!access.allow) { this.#inbox.remove(entry.id); return }
        const workingDirectory = entry.workingDirectory ?? this.#options.workingDirectory
        if (!this.#routes.acceptsQueued(entry)) {
          if (!queued.blocked) void this.send(message, { kind: 'notice', text: '排队任务所属项目已移除或目录不可用，暂未开始。请在 DSH 恢复配置，或发 /clear 清除自己的排队消息。' }).catch((error) => this.logger.warn(String(error)))
          queued.blocked = true
          throw new Error('queued project is unavailable or no longer configured; input retained for /clear')
        }
        const record: TaskRecord = {
          workingDirectory, project: entry.project, replyMessage: message,
          id: entry.id, target: { channel: message.channel, accountId: message.accountId, conversationId: message.conversationId },
          senderId: message.senderId, summary: message.text.trim().replace(/\s+/g, ' ').slice(0, 80) || `附件任务（${message.media.length} 个）`,
          startedAt: Date.now(), execution: 'running', delivery: 'none',
        }
        if (!this.#tasks.save(record)) {
          if (!queued.blocked) {
            queued.blocked = true
            void this.send(message, { kind: 'notice', text: '任务已接收，但任务记录无法保存，暂未开始执行。请在 DSH 检查状态目录，或发 /clear 清除排队消息。' }).catch((error) => this.logger.warn(`blocked notice failed: ${String(error)}`))
          }
          throw new Error('task state could not be saved; queued input retained')
        }
        queued.blocked = false
        // Removal is the start boundary: after this point tools may have effects and must not be replayed.
        this.#inbox.remove(entry.id)
        this.#acceptInbound(message, reservation)
        charged = true
        queued.finish = undefined
        await this.#runTurn(message, entry.sessionId, signal, record, entry.project)
      })
      .catch((error: unknown) => {
        this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${String((error as Error)?.message ?? error)}`)
      })
      .finally(() => {
        if (!charged) reservation(false)
        queued.scheduled = false
        queued.finish = undefined
        if (!this.#inbox.list().some((item) => item.id === entry.id)) this.#queuedInputs.delete(entry.id)
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

  /** Run one chat command and answer in the chat. Never starts a turn. */
  async #runCommand(message: InboundMessage, name: CommandName, args: string): Promise<void> {
    if (name === 'schedule' || name === 'schedules') {
      if (!this.canManage(message)) { await this.send(message, { text: '只有管理员可以管理计划。', kind: 'notice' }); return }
      await this.#schedules.command(message, name, args); return
    }
    if (name === 'sessions' || name === 'session') {
      await this.send(message, { kind: 'notice', text: '已移除手机历史会话切换。请在 DSH 查看历史会话；/new 可开始新会话。' })
      return
    }
    if (name === 'projects' || name === 'project' || name === 'new') {
      if (name !== 'projects' && !this.canManage(message)) { await this.send(message, { text: '只有管理员可以切换项目或会话。', kind: 'notice' }); return }
      await this.send(message, { kind: 'notice', text: this.#routes.command(message, name, args) })
      return
    }
    if (name === 'files' || name === 'resend') {
      await answerArtifactCommand({
        message, name, args, tasks: this.#tasks,
        workspace: this.#options.workingDirectory,
        workspaceFor: (task) => this.#routes.artifactWorkspace(task),
        maxBytes: this.config.maxProducedBytes,
        authorized: () => !this.#disposed && authorizeMessage(message, this.gateContext()).allow,
        send: (outgoing) => this.send(message, outgoing),
      })
      return
    }
    if (name === 'help') {
      await this.send(message, { text: helpText(), kind: 'notice' })
      return
    }
    if (name === 'whoami') {
      await this.send(message, {
        text: chatParagraphs(
          '【当前聊天】',
          `发送者 ID：${message.senderId}`,
          `聊天 ID：${message.conversationId}`,
          `通道：${message.channel}（账号 ${message.accountId}）`,
          `角色：${this.canManage(message) ? '管理员' : '成员'}`,
          `DSH 会话：${this.#routes.snapshot(message).sessionId}`,
        ),
        kind: 'notice',
      })
      return
    }
    if (name === 'cancel') {
      const active = this.#activeTasks.get(lineKey(message))
      if (active === undefined || active.record.execution === 'completed') {
        await this.send(message, { text: '当前没有可停止的任务。', kind: 'notice' })
        return
      }
      if (active.record.senderId !== message.senderId) {
        await this.send(message, { text: '只有任务发起者可以停止当前任务。', kind: 'notice' })
        return
      }
      active.record = { ...active.record, execution: 'stopping' }
      this.#tasks.update(message, active.record.id, { execution: 'stopping' })
      const notice = this.send(message, { text: '已请求停止当前任务。排队消息会保留。', kind: 'notice' })
      active.controller.abort('user-cancel')
      await notice
      return
    }
    if (name === 'clear') {
      const entries = this.#inbox.list().filter((entry) => sameTarget(entry.message, message) && entry.message.senderId === message.senderId)
      if (entries.length === 0) {
        await this.send(message, { text: '你没有尚未开始的排队消息。', kind: 'notice' })
        return
      }
      try { this.#inbox.clear(new Set(entries.map((entry) => entry.id))) }
      catch {
        await this.send(message, { text: '未能清除排队消息。请在 DSH 检查通道状态后重试。', kind: 'notice' })
        return
      }
      for (const entry of entries) {
        this.#queuedInputs.get(entry.id)?.finish?.(false)
        this.#queuedInputs.delete(entry.id)
        this.#acceptInbound(entry.message)
      }
      await this.send(message, { text: `已清除 ${entries.length} 条你的排队消息。`, kind: 'notice' })
      return
    }
    if (name === 'tasks' || name === 'status') {
      const outbox = this.#delivery.outbox.list().filter((entry) => sameTarget(entry.target, message))
      const context = {
        active: this.#activeTasks.get(lineKey(message))?.record,
        interaction: this.#interactions.active(message),
        pendingTaskIds: new Set(outbox.flatMap((entry) => entry.taskId === undefined ? [] : [entry.taskId])),
      }
      const text = name === 'tasks'
        ? taskHistoryText(this.#tasks.recent(message, message.group ? message.senderId : undefined), context)
        : taskStatusText({
          channel: this.#adapters.get(message.channel)?.label.zh ?? message.channel,
          latest: this.#tasks.latest(message),
          queued: this.pendingInputs(message),
          pending: outbox.length,
          promptSending: context.interaction === undefined && this.#interactions.busy(message),
          context,
        })
      const blocked = this.#inbox.list().some((entry) => sameTarget(entry.message, message) && this.#queuedInputs.get(entry.id)?.blocked)
      await this.send(message, { text: blocked ? `${text}\n\n排队任务暂未开始：请在 DSH 检查项目目录及任务状态存储。` : text, kind: 'notice' })
      return
    }
    const unknown: never = name
    throw new Error(`unknown command: ${String(unknown)}`)
  }

  async #runTurn(message: InboundMessage, sessionId: string, queueSignal: AbortSignal, record: TaskRecord, project = 'default'): Promise<void> {
    if (queueSignal.aborted || this.#disposed) return
    const adapter = this.#adapters.get(message.channel)
    if (adapter === undefined) return
    const taskId = record.id
    const controller = new AbortController()
    const signal = AbortSignal.any([queueSignal, controller.signal])
    const key = lineKey(message)
    const active = { record, controller }
    this.#activeTasks.set(key, active)
    const cardNow = (): { messageId: string } | undefined => this.#queuedInputs.get(record.id)?.card
    const receipt = this.#queuedInputs.get(record.id)?.receipt
    // Give a fast receipt one event-loop turn to resolve so the card can show
    // "执行中"; a slow receipt never delays the turn.
    if (adapter.capabilities.edit === true && receipt !== undefined) {
      await Promise.race([receipt, new Promise<void>((resolve) => setImmediate(resolve))])
    }
    const initialCard = cardNow()
    if (initialCard !== undefined) await this.#delivery.editCard(message, initialCard, '执行中…')
    if (typeof adapter.typing === 'function') void adapter.typing(message).catch(() => {})
    const workingDirectory = record.workingDirectory ?? this.#options.workingDirectory
    try {
      let reply
      let late: ((result: TurnReply) => void) | undefined
      const settled = new Promise<TurnReply>((resolve) => { late = resolve })
      const progressNotice = setTimeout(() => {
        if (signal.aborted || this.#disposed || this.#interactions.busy(message)) return
        const card = cardNow()
        if (card !== undefined) void this.#delivery.editCard(message, card, chatParagraphs('任务仍在处理。', '/status 查看状态　｜　/cancel 请求停止'))
        else void this.send(message, { text: chatParagraphs('任务仍在处理。', '/status 查看状态　｜　/cancel 请求停止'), kind: 'notice' })
          .catch((error: unknown) => this.logger.warn(`progress notice failed for ${key}: ${String(error)}`))
      }, 60_000)
      progressNotice.unref()
      try {
        reply = await this.#driver.run({
          message, signal, sessionId, workingDirectory,
          deliverFiles: this.#options.config.autoSendFiles,
          onSettled: (result) => late?.(result),
          beforeSubmit: (binding) => {
            if (this.#disposed || !authorizeMessage(message, this.gateContext()).allow
              || !this.#routes.acceptsQueued({ id: record.id, message, sessionId: binding.sessionId, project, workingDirectory })) throw new Error('input authorization or project changed before submission')
            const recovery = { ...binding, message, project }
            if (!this.#tasks.update(message, taskId, { recovery })) throw new Error('host input identity could not be persisted; submission refused')
          },
        })
      }
      catch (error) { reply = { sessionId, text: String(error), failed: true, cancelled: false, interrupted: false, settled: false } }
      finally { clearTimeout(progressNotice) }
      if (reply.pending === true) {
        await this.send(message, { text: '任务仍在后台处理；结果确认后会继续发送到此聊天。发 /status 查看。', kind: 'notice' })
        reply = await settled
        if (this.#disposed || queueSignal.aborted) return
      }
      if (this.#disposed || queueSignal.aborted) return
      if (controller.signal.aborted && (reply.cancelled === true || reply.settled !== true)) {
        const confirmed = reply.cancelled === true
        this.#tasks.update(message, taskId, { execution: confirmed ? 'cancelled' : 'unknown', endedAt: Date.now(), ...(confirmed ? { recovery: undefined } : {}) })
        const notice = confirmed ? '当前任务已取消。已完成的操作不会自动撤销。' : '停止尚未得到宿主确认。请在 DSH 核对任务状态和已完成的操作。'
        const card = cardNow()
        if (card !== undefined && await this.#delivery.editCard(message, card, notice)) return
        await this.send(message, { text: notice, kind: 'notice' })
        return
      }
      this.#activeTasks.delete(key)
      await this.#finishTurn(message, record, reply, cardNow())
    } finally {
      if (this.#activeTasks.get(key) === active) this.#activeTasks.delete(key)
    }
  }

  /** Live execution and restart reconciliation share one result/attachment path. */
  async #finishTurn(message: InboundMessage, record: TaskRecord, reply: TurnReply, taskCard?: { messageId: string }): Promise<void> {
    const taskId = record.id
    const key = lineKey(message)
    const workingDirectory = record.workingDirectory ?? this.#options.workingDirectory
    const planned = !reply.failed && this.config.autoSendFiles
      ? await prepareTaskArtifacts({
        record: { outputDirectory: record.outputDirectory, artifacts: record.artifacts, artifactsIncomplete: record.artifactsIncomplete },
        reply, workingDirectory,
        maxFiles: this.config.maxProducedFiles, maxBytes: this.config.maxProducedBytes,
      })
      : { index: {}, attachments: [] as ArtifactDelivery[], notices: [] }
    for (const text of planned.notices) {
      await this.send(message, { kind: 'notice', text }).catch((error: unknown) => this.logger.warn(`deliverable notice failed: ${String(error)}`))
    }
    const artifacts = planned.index
    const captureIncomplete = artifacts.artifactsIncomplete === true
    const completion: Partial<TaskRecord> = { ...artifacts, filesUnsent: (artifacts.artifacts?.length ?? 0) > 0 || captureIncomplete, execution: reply.cancelled === true ? 'cancelled' : reply.interrupted === true ? 'unknown' : reply.failed === true ? 'failed' : 'completed', endedAt: Date.now(), delivery: reply.failed === true ? 'none' : 'sending' }
    const saved = this.#tasks.update(message, taskId, completion)
    if (!saved && !reply.failed && artifacts.outputDirectory !== undefined) await this.send(message, { kind: 'notice', text: '产物索引未能保存，本轮结果仍会发送。请在 DSH 保留文件，历史取回暂不可用。' })
    this.logger.info(`turn for ${key} settled in ${Date.now() - record.startedAt}ms (${reply.text.length} chars)`)
    if (reply.failed === true) {
      if (reply.settled) this.#tasks.update(message, taskId, { recovery: undefined })
      this.logger.warn(`turn failed for ${key}: ${reply.text}`)
      const text = reply.cancelled === true ? '当前任务已取消。已完成的操作不会自动撤销。' : reply.interrupted === true ? '任务等待超时，执行结果未确认。请在 DSH 核对后再决定是否重试。' : '任务执行失败。请在 DSH 核对已经完成的操作，可发 /status 查看状态。'
      const card = taskCard
      if (card !== undefined && await this.#delivery.editCard(message, card, text)) return
      await this.send(message, { text, kind: 'notice' })
      return
    }
    const card = taskCard
    if (card !== undefined) await this.#delivery.editCard(message, card, '任务已完成。')
    const body = reply.text.trim() !== '' ? reply.text : planned.attachments.length ? '' : '任务已完成。没有可发送的文字或文件。'
    const results = await this.#delivery.enqueueReply(message, body, taskId, planned.attachments, completion)
    // The outbox commits every text/file receipt and its task state together.
    // Before handoff succeeds, keep host recovery as the source of the result.
    if (this.#tasks.get(message, taskId)?.recovery !== undefined) {
      this.#tasks.update(message, taskId, { delivery: 'failed', filesUnsent: captureIncomplete || planned.attachments.length > 0 })
    }

    if (results.some((result) => !result.ok && result.code === 'outbox-persist')) await this.send(message, { kind: 'notice', text: '结果发送失败，待重发记录也未能保存。请在 DSH 取回结果并检查状态目录。' })
  }

  /** Persist replies before sending; ephemeral notices and prompts send directly. */
  send(target: Target, outgoing: Outgoing, taskId?: string): Promise<SendResult[]> {
    return this.#delivery.send(target, outgoing, taskId)
  }

  startOutboxRetry(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.resumePending()
      void this.#delivery.retry()
        .catch((error: unknown) => this.#options.logger.warn(`outbox retry failed: ${String(error)}`))
    }, intervalMs)
    timer.unref?.()
    const stop = (): void => clearInterval(timer)
    this.#stopTimers.push(stop)
    return stop
  }

  /** Stop every timer this runtime started, and reject every pending interaction. */
  dispose(): Promise<void> {
    this.#disposed = true
    this.#delivery.dispose()
    this.#ingressStop.abort()
    this.#ingressTails.clear()
    this.#queue.dispose()
    for (const stop of this.#stopTimers.splice(0)) stop()
    this.#interactions.dispose()
    this.#schedules.dispose()
    return this.#driver.dispose()
  }
}
