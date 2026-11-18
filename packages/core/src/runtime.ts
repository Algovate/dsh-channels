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

import { answerArtifactCommand, captureArtifacts } from './artifacts.js'
import { InteractionQueue } from './interaction/queue.js'
import { isApprovalReply } from './interaction/approval.js'
import { ConversationQueue } from './inbound/queue.js'
import { authorizeMessage, createDurableRateLimiter, createRateLimiter, reserveMessage, type GateContext, type GateDecision, type Reservation } from './inbound/gates.js'
import type { CounterStore } from './store/counters.js'
import { allowlistFor, type ChannelsConfig } from './config.js'
import { lineKey, sameTarget, sessionIdFor } from './ids.js'
import { helpText, parseCommand, TASK_CONTROLS, type CommandName } from './commands.js'
import { SessionLines } from './store/lines.js'
import { Inbox, type InboxEntry } from './store/inbox.js'
import { Outbox } from './store/outbox.js'
import { Tasks, type TaskRecord } from './store/tasks.js'
import { Journal } from './store/journal.js'
import { TurnDriver } from './turns.js'
import { chatParagraphs, plainText, splitIntoBubbles } from './outbound.js'
import { scanProducedFiles } from './produced.js'
import { taskHistoryText, taskStatusText } from './task-messages.js'
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
  readonly #inbox: Inbox
  readonly #queuedInputs = new Map<string, { scheduled: boolean; finish?: Reservation; blocked?: boolean }>()
  readonly #activeTasks = new Map<string, { record: TaskRecord; controller: AbortController }>()
  readonly #tasks: Tasks
  #resuming = false
  readonly #outbox: Outbox
  readonly #journal: Journal
  readonly #driver: TurnDriver
  readonly #interactions: InteractionQueue
  /** Sessions already reported to the host's workspace grouping. */
  readonly #grouped = new Set<string>()
  /** conversation line → session line number chosen by `/new`. */
  readonly #lines: SessionLines
  /** Built once: a limiter recreated per message would never accumulate. */
  readonly #minute: GateContext['minute']
  readonly #day: GateContext['day']
  readonly #preflightReservations = new WeakMap<InboundMessage, Reservation>()
  #disposed = false
  readonly #stopTimers: Array<() => void> = []

  constructor(options: RuntimeOptions) {
    this.#options = options
    this.#lines = new SessionLines(options.stateRoot, options.logger.warn)
    this.#inbox = new Inbox(options.stateRoot, options.logger.warn)
    this.#tasks = new Tasks(options.stateRoot, options.logger.warn)
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
      onAttach: (_target, sessionId) => {
        if (!this.#grouped.has(sessionId)) {
          this.#grouped.add(sessionId)
          try {
            this.#options.attachToWorkspace?.(sessionId)
          } catch {
            // Grouping is cosmetic; a callback cannot fail a turn.
          }
        }

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
    const command = parseCommand(message.text)
    return (command !== null && TASK_CONTROLS.has(command.name)) || isApprovalReply(message.text) || this.#interactions.busy(message)
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
    const command = parseCommand(message.text)
    if (!hasAttachments && (isApprovalReply(message.text) || (command !== null && TASK_CONTROLS.has(command.name)))) return true
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
    const context = this.gateContext()
    const access = this.#checkInbound(message, context)
    if (!access.allow) {
      this.cancelReceive(message)
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

  /** Schedule saved work only after its channel has started; retry quota waits periodically. */
  async resumePending(): Promise<void> {
    if (this.#disposed || this.#resuming) return
    this.#resuming = true
    try {
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
  }

  #enqueueTurn(message: InboundMessage, reservation: Reservation, saved?: InboxEntry): void {
    let entry: InboxEntry
    try { entry = saved ?? this.#inbox.add(message, this.#sessionIdFor(message)) }
    catch (error) { reservation(false); throw error }
    const queued = this.#queuedInputs.get(entry.id) ?? { scheduled: false }
    queued.scheduled = true
    queued.finish = reservation
    this.#queuedInputs.set(entry.id, queued)
    if (saved === undefined) {
      const ahead = this.pendingInputs(message) - 1 + (this.#activeTasks.has(lineKey(message)) ? 1 : 0)
      void this.send(message, { text: ahead > 0 ? `已接收，前面有 ${ahead} 个任务。发 /status 查看队列。` : '已接收，准备处理。', kind: 'notice' }).catch((error) => this.logger.warn(`receipt notice failed: ${String(error)}`))
    }
    let charged = false
    void this.#queue
      .push(lineKey(message), async (signal) => {
        if (signal.aborted || this.#disposed || !this.#adapters.has(message.channel)) return
        if (!this.#inbox.list().some((item) => item.id === entry.id)) return
        const access = authorizeMessage(message, this.gateContext())
        if (!access.allow) { this.#inbox.remove(entry.id); return }
        const record: TaskRecord = {
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
        await this.#runTurn(message, entry.sessionId, signal, record)
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

  /**
   * The session id this conversation is on.
   *
   * Line 0 is the deterministic id every existing conversation already uses;
   * `/new` moves the conversation to line 1, 2, … so the old session stays
   * intact (and visible in the GUI) while the next message starts clean. The
   * line is persisted in the session-line store, so a restart does not walk back.
   */
  #sessionIdFor(message: InboundMessage): string {
    const key = lineKey(message)
    const stored = this.#options.counters?.get(`line:${key}`)
    const line = this.#lines.get(key) ?? (stored !== undefined && stored > 0 ? Math.floor(stored) : 0)
    if (line === 0) return sessionIdFor(message)
    return sessionIdFor({ ...message, conversationId: `${message.conversationId}#${line}` })
  }

  /** Run one chat command and answer in the chat. Never starts a turn. */
  async #runCommand(message: InboundMessage, name: CommandName, args: string): Promise<void> {
    if (name === 'files' || name === 'resend') {
      await answerArtifactCommand({
        message, name, args, tasks: this.#tasks,
        workspace: this.#options.workingDirectory,
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
          `DSH 会话：${this.#sessionIdFor(message)}`,
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
      const outbox = this.#outbox.list().filter((entry) => sameTarget(entry.target, message))
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
          recent: this.#journal.outbound(undefined, message, 'reply'),
          context,
        })
      const blocked = this.#inbox.list().some((entry) => sameTarget(entry.message, message) && this.#queuedInputs.get(entry.id)?.blocked)
      await this.send(message, { text: blocked ? `${text}\n\n排队任务暂未开始：任务记录无法保存，请在 DSH 检查状态目录。` : text, kind: 'notice' })
      return
    }
    if (name !== 'new') {
      const unknown: never = name
      throw new Error(`unknown command: ${String(unknown)}`)
    }
    // `/new`: commit identity before changing the live conversation.
    const key = lineKey(message)
    const next = (this.#lines.get(key) ?? this.#options.counters?.get(`line:${key}`) ?? 0) + 1
    if (!this.#lines.set(key, next)) {
      await this.send(message, { text: '未能开新会话。后续消息仍会进入原会话，请在 DSH 检查通道状态。', kind: 'notice' })
      return
    }
    this.#options.logger.info(`${key} starts session line ${next}`)
    await this.send(message, { text: `已开新会话（第 ${next} 条）。下一条任务会使用新会话，原会话可在 DSH 查看。`, kind: 'notice' })
  }

  async #runTurn(message: InboundMessage, sessionId: string, queueSignal: AbortSignal, record: TaskRecord): Promise<void> {
    if (queueSignal.aborted || this.#disposed) return
    const adapter = this.#adapters.get(message.channel)
    if (adapter === undefined) return
    const taskId = record.id
    const controller = new AbortController()
    const signal = AbortSignal.any([queueSignal, controller.signal])
    const key = lineKey(message)
    const active = { record, controller }
    this.#activeTasks.set(key, active)
    if (typeof adapter.typing === 'function') void adapter.typing(message).catch(() => {})
    const outputDir = this.#turnOutputDirectory()
    try {
      let reply
      const progressNotice = setTimeout(() => {
        if (signal.aborted || this.#disposed || this.#interactions.busy(message)) return
        void this.send(message, { text: chatParagraphs('任务仍在处理。', '/status 查看状态　｜　/cancel 请求停止'), kind: 'notice' })
          .catch((error: unknown) => this.logger.warn(`progress notice failed for ${key}: ${String(error)}`))
      }, 60_000)
      progressNotice.unref()
      try { reply = await this.#driver.run({ message, signal, sessionId, outputDirectory: outputDir }) }
      catch (error) { reply = { text: String(error), failed: true, cancelled: false, interrupted: false, settled: false } }
      finally { clearTimeout(progressNotice) }
      if (this.#disposed || queueSignal.aborted) return
      if (controller.signal.aborted && (reply.cancelled === true || reply.settled !== true)) {
        const confirmed = reply.cancelled === true
        this.#tasks.update(message, taskId, { execution: confirmed ? 'cancelled' : 'unknown', endedAt: Date.now() })
        await this.send(message, { text: confirmed ? '当前任务已取消。已完成的操作不会自动撤销。' : '停止尚未得到宿主确认。请在 DSH 核对任务状态和已完成的操作。', kind: 'notice' })
        return
      }
      this.#activeTasks.delete(key)
      const artifacts = !reply.failed && outputDir !== undefined ? await captureArtifacts(outputDir) : {}
      const saved = this.#tasks.update(message, taskId, { ...artifacts, execution: reply.interrupted === true ? 'unknown' : reply.failed === true ? 'failed' : 'completed', endedAt: Date.now(), delivery: reply.failed === true ? 'none' : 'sending' })
      if (!saved && !reply.failed && outputDir !== undefined) await this.send(message, { kind: 'notice', text: '产物索引未能保存，本轮结果仍会发送。请在 DSH 保留文件，历史取回暂不可用。' })
      this.logger.info(`turn for ${key} settled in ${Date.now() - record.startedAt}ms (${reply.text.length} chars)`)
      if (reply.failed === true) {
        this.logger.warn(`turn failed for ${key}: ${reply.text}`)
        await this.send(message, { text: reply.interrupted === true ? '任务等待超时，执行结果未确认。请在 DSH 核对后再决定是否重试。' : '任务执行失败。请在 DSH 核对已经完成的操作，可发 /status 查看状态。', kind: 'notice' })
        return
      }
      const results: SendResult[] = []
      if (reply.text.trim() !== '') results.push(...await this.send(message, { text: reply.text, kind: 'reply' }, taskId))
      // Preserve files even when the text is waiting for retry; do not claim they were sent.
      if (!results.some((result) => !result.ok) && outputDir !== undefined && !this.#disposed) results.push(...await this.#sendProducedFiles(message, outputDir, taskId))
      if (results.length === 0) results.push(...await this.send(message, { text: '任务已完成。没有可发送的文字或文件。', kind: 'reply' }, taskId))
      const pending = this.#outbox.list().some((entry) => entry.taskId === taskId)
      const unconfirmed = results.some((result) => result.ok && result.unconfirmed)
      let filesUnsent = false
      if (results.some((result) => !result.ok) && outputDir !== undefined) {
        try { filesUnsent = fs.readdirSync(outputDir).length > 0 } catch { filesUnsent = true }
      }
      const delivery = pending ? 'pending' : results.some((result) => !result.ok) ? 'failed' : results.some((result) => result.ok && result.unconfirmed) ? 'unknown' : 'sent'
      this.#tasks.update(message, taskId, { delivery, unconfirmed, filesUnsent })
      if (results.some((result) => !result.ok && result.code === 'outbox-persist')) await this.send(message, { kind: 'notice', text: '结果发送失败，待重发记录也未能保存。请在 DSH 取回结果并检查状态目录。' })
    } finally {
      if (this.#activeTasks.get(key) === active) this.#activeTasks.delete(key)
      if (outputDir !== undefined) { try { fs.rmdirSync(outputDir) } catch { /* Keep artifacts. */ } }
    }
  }

  /** Send one outgoing message, split to the channel's capability, with outbox fallback. */
  async send(target: Target, outgoing: Outgoing, taskId?: string): Promise<SendResult[]> {
    if (this.#disposed) return [{ ok: false, code: 'stopped' }]
    const adapter = this.#adapters.get(target.channel)
    if (adapter === undefined) return [{ ok: false, code: 'unknown-channel', detail: target.channel }]
    const text = outgoing.text === undefined ? '' : plainText(outgoing.text)
    const limit = Number.isFinite(adapter.capabilities.maxTextChars) && adapter.capabilities.maxTextChars > 0 ? adapter.capabilities.maxTextChars : this.#options.config.maxTextChars
    const bubbles = splitIntoBubbles(text, limit)
    if (outgoing.kind === 'reply' && bubbles.length > 0 && this.#outbox.list().some((entry) => sameTarget(entry.target, target))) {
      const saved = this.#outbox.add(target, { kind: 'reply', text: bubbles[0]! }, { code: 'queued', remaining: bubbles.slice(1), taskId })
      return [{ ok: false, code: saved === undefined ? 'outbox-persist' : 'queued' }]
    }
    const results: SendResult[] = []
    const base = { kind: outgoing.kind }
    for (const [index, bubble] of bubbles.entries()) {
      if (index > 0 && this.#options.config.bubbleGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#options.config.bubbleGapMs))
      if (this.#disposed) return [...results, { ok: false, code: 'stopped' }]
      const id = `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const result = await this.#deliver(adapter, target, { ...base, text: bubble }, bubble, id)
      results.push(result)
      if (!result.ok) {
        if (outgoing.kind === 'reply' && this.#outbox.add(target, { kind: 'reply', text: bubble }, { id, code: result.code, retryAfterMs: result.retryAfterMs, remaining: bubbles.slice(index + 1), taskId }) === undefined) results[results.length - 1] = { ok: false, code: 'outbox-persist' }
        return results
      }
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
  async #sendProducedFiles(message: InboundMessage, outputDir: string, taskId: string): Promise<SendResult[]> {
    if (this.#options.config.autoSendFiles !== true) return []
    const scan = await scanProducedFiles({
      dir: outputDir, sinceMs: 0,
      maxFiles: this.#options.config.maxProducedFiles,
      maxBytes: this.#options.config.maxProducedBytes,
    })
    const media = scan.files.map((file) => ({ kind: 'file' as const, path: file.path, name: file.name, bytes: file.bytes }))
    const results = media.length === 0 ? [] : await this.send(message, { kind: 'reply', media }, taskId)
    if (scan.skipped > 0 || scan.incomplete) {
      results.push({ ok: false, code: 'files-skipped' })
      await this.send(message, { kind: 'notice', text: `部分附件未发送：${scan.skipped > 0 ? `${scan.skipped} 个文件超过数量或大小限制、为空或是符号链接。` : ''}${scan.incomplete ? '输出目录未能完整扫描。' : ''}请在 DSH 取回文件。` })
    }
    return results
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
    return result
  }

  /** Start a periodic outbox retry; returns the stop function. */
  startOutboxRetry(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.resumePending()
      const retryTasks = new Map<string, { id: string; target: Target; unconfirmed: boolean }>()
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
          if ((entry.part ?? 0) > 0 && this.config.bubbleGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.config.bubbleGapMs))
          if (this.#disposed) return { ok: false as const, code: 'stopped' }
          const result = await this.#deliver(adapter, entry.target, entry.outgoing, entry.outgoing.text ?? '', entry.part === undefined ? entry.id : `${entry.id}:${entry.part}`)
          if (entry.taskId !== undefined && result.ok) {
            const previous = retryTasks.get(entry.taskId)
            retryTasks.set(entry.taskId, { id: entry.taskId, target: entry.target, unconfirmed: previous?.unconfirmed === true || result.unconfirmed === true })
            if (result.unconfirmed) this.#tasks.update(entry.target, entry.taskId, { unconfirmed: true })
          }
          return result.ok === true ? { ok: true as const } : { ok: false as const, code: result.code, retryAfterMs: result.retryAfterMs }
        })
        .then(() => {
          for (const task of retryTasks.values()) {
            if (this.#outbox.list().some((entry) => entry.taskId === task.id && sameTarget(entry.target, task.target))) continue
            const saved = this.#tasks.get(task.target, task.id)
            const delivery = saved?.filesUnsent ? 'failed' : task.unconfirmed || saved?.unconfirmed || saved?.delivery === 'unknown' ? 'unknown' : 'sent'
            this.#tasks.update(task.target, task.id, { delivery })
          }
          retryTasks.clear()
        })
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
    this.#queue.dispose()
    for (const stop of this.#stopTimers.splice(0)) stop()
    this.#interactions.dispose()
    return this.#driver.dispose()
  }
}
