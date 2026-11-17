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
import { helpText, parseCommand, TASK_CONTROLS, type CommandName } from './commands.js'
import { SessionLines } from './store/lines.js'
import { Inbox, type InboxEntry } from './store/inbox.js'
import { Outbox } from './store/outbox.js'
import { Tasks, type TaskRecord } from './store/tasks.js'
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
  readonly #scheduledInbox = new Set<string>()
  readonly #queuedReservations = new Map<string, Reservation>()
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
  readonly #queuedReceipts = new Set<string>()
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
    if (!hasAttachments && command !== null && TASK_CONTROLS.has(command.name)) return true
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
    if (id !== undefined && (this.#inbox.contains(message) || this.#queuedReceipts.has(receiptKey(message, id)) || this.#journal.received(message, id))) {
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
    if (command !== null && TASK_CONTROLS.has(command.name)) {
      reservation?.(false)
      this.#acceptInbound(message)
      void this.#runCommand(message, command.name).catch((error: unknown) => this.logger.warn(`command /${command.name} failed: ${String(error)}`))
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

  /** Schedule saved work only after its channel has started; retry quota waits periodically. */
  async resumePending(): Promise<void> {
    if (this.#disposed || this.#resuming) return
    this.#resuming = true
    try {
      for (const entry of this.#inbox.list()) {
        if (this.#scheduledInbox.has(entry.id)) continue
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
    this.#scheduledInbox.add(entry.id)
    this.#queuedReservations.set(entry.id, reservation)
    if (saved === undefined) {
      const ahead = this.pendingInputs(message) - 1 + (this.#activeTasks.has(lineKey(message)) ? 1 : 0)
      void this.send(message, { text: ahead > 0 ? `已接收，前面有 ${ahead} 个任务。` : '已接收，准备处理。', kind: 'notice' }).catch((error) => this.logger.warn(`receipt notice failed: ${String(error)}`))
    }
    const id = message.platformMessageId === undefined ? undefined : receiptKey(message, message.platformMessageId)
    if (id !== undefined) this.#queuedReceipts.add(id)
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
        if (!this.#tasks.save(record)) throw new Error('task state could not be saved; queued input retained')
        // Removal is the start boundary: after this point tools may have effects and must not be replayed.
        this.#inbox.remove(entry.id)
        if (id !== undefined) this.#queuedReceipts.delete(id)
        this.#acceptInbound(message, reservation)
        charged = true
        this.#queuedReservations.delete(entry.id)
        await this.#runTurn(message, entry.sessionId, signal, record)
      })
      .catch((error: unknown) => {
        this.#options.logger.warn(`turn failed for ${lineKey(message)}: ${String((error as Error)?.message ?? error)}`)
      })
      .finally(() => {
        if (!charged) reservation(false)
        if (id !== undefined) this.#queuedReceipts.delete(id)
        this.#scheduledInbox.delete(entry.id)
        this.#queuedReservations.delete(entry.id)
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
  async #runCommand(message: InboundMessage, name: CommandName): Promise<void> {
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
    if (name === 'cancel') {
      const active = this.#activeTasks.get(lineKey(message))
      if (active === undefined || active.record.execution === 'completed') {
        await this.send(message, { text: '当前没有可停止的任务。', kind: 'notice' })
        return
      }
      if (active.record.senderId !== message.senderId) {
        await this.send(message, { text: '请由任务发起者停止这次任务。', kind: 'notice' })
        return
      }
      active.record = { ...active.record, execution: 'stopping' }
      this.#tasks.update(message, active.record.id, { execution: 'stopping' })
      const notice = this.send(message, { text: '已请求停止当前任务；已完成的操作不会自动撤销。排队消息保留。', kind: 'notice' })
      active.controller.abort('user-cancel')
      await notice
      return
    }
    if (name === 'clear') {
      const entries = this.#inbox.list().filter((entry) => sameTarget(entry.message, message) && entry.message.senderId === message.senderId)
      try { this.#inbox.clear(new Set(entries.map((entry) => entry.id))) }
      catch {
        await this.send(message, { text: '无法保存清除结果，排队消息保持原样。请检查状态目录后重试。', kind: 'notice' })
        return
      }
      for (const entry of entries) {
        this.#queuedReservations.get(entry.id)?.(false)
        this.#queuedReservations.delete(entry.id)
        this.#acceptInbound(entry.message)
      }
      await this.send(message, { text: `已清除 ${entries.length} 条自己的排队消息；当前任务继续执行。`, kind: 'notice' })
      return
    }
    if (name === 'status') {
      const paragraphs = [`【任务状态 · ${message.channel}】`]
      const outbox = this.#outbox.list().filter((entry) => sameTarget(entry.target, message))
      const active = this.#activeTasks.get(lineKey(message))
      const saved = this.#tasks.latest(message)
      const task = active?.record ?? (saved === undefined ? undefined : { ...saved, execution: saved.execution === 'running' || saved.execution === 'stopping' ? 'unknown' as const : saved.execution })
      if (task !== undefined) {
        const interaction = this.#interactions.active(message)
        const execution = task.execution === 'running' && interaction !== undefined ? (interaction === 'approval' ? '等待审批' : '等待回答') : {
          running: '执行中', stopping: '正在停止', completed: '完成', failed: '失败', cancelled: '已取消', unknown: '未知（执行结束未确认，请先核对再重试）',
        }[task.execution]
        const pending = outbox.some((entry) => entry.taskId === task.id)
        const delivery = task.delivery === 'pending' && !pending ? '未知（待重发记录已不在队列，请核对）' : {
          none: '尚无结果', sending: '发送中', sent: '已发送', pending: task.filesUnsent ? '文字待重发（附件请到桌面取回）' : '待重发', unknown: '投递结果未知', failed: '发送失败（请到桌面取回文件）',
        }[task.delivery]
        const seconds = Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.startedAt) / 1000))
        paragraphs.push(
          `${active === undefined ? '最近任务' : '当前任务'}：${statusPreview(task.summary, 42)}`,
          `执行状态：${execution}　｜　已用时：${seconds} 秒`,
          `结果投递：${delivery}`,
        )
      } else paragraphs.push('当前任务：无')
      paragraphs.push(`【队列】排队：${this.pendingInputs(message)} 条　｜　待重发：${outbox.length} 条`)
      if (this.#interactions.busy(message) && this.#interactions.active(message) === undefined) paragraphs.push('提示发送中')
      const recent = this.#journal.outbound(undefined, message, 'reply').slice(-2).reverse()
      if (recent.length > 0) {
        paragraphs.push('【最近结果】')
        const labels = { accepted: '已发送', unconfirmed: '未确认', failed: '发送失败', pending: '投递未知' }
        const previews = new Map<string, number>()
        for (const entry of recent) {
          const preview = `${labels[entry.state]}｜${statusPreview(entry.text, 28) || '附件'}`
          previews.set(preview, (previews.get(preview) ?? 0) + 1)
        }
        for (const [preview, count] of previews) {
          paragraphs.push(count > 1 ? `· ${preview}（${count} 条）` : `· ${preview}`)
        }
      }
      // WeChat renders single line breaks as spaces and preserves paragraph breaks.
      await this.send(message, { text: paragraphs.join('\n\n'), kind: 'notice' })
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
      await this.send(message, { text: '无法保存新会话，仍使用原会话。请检查状态目录后重试。', kind: 'notice' })
      return
    }
    this.#options.logger.info(`${key} starts session line ${next}`)
    await this.send(message, { text: `好，这条聊天从这里开新会话（第 ${next} 条）。上一条还留在 GUI 里。`, kind: 'notice' })
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
      try { reply = await this.#driver.run({ message, signal, sessionId, outputDirectory: outputDir }) }
      catch (error) { reply = { text: String(error), failed: true, cancelled: false, interrupted: false, settled: false } }
      if (this.#disposed || queueSignal.aborted) return
      if (controller.signal.aborted && (reply.cancelled === true || reply.settled !== true)) {
        const confirmed = reply.cancelled === true
        this.#tasks.update(message, taskId, { execution: confirmed ? 'cancelled' : 'unknown', endedAt: Date.now() })
        await this.send(message, { text: confirmed ? '当前任务已取消；已完成的操作不会自动撤销。' : '停止尚未得到宿主确认，请在桌面核对；已完成的操作不会自动撤销。', kind: 'notice' })
        return
      }
      this.#activeTasks.delete(key)
      this.#tasks.update(message, taskId, { execution: reply.interrupted === true ? 'unknown' : reply.failed === true ? 'failed' : 'completed', endedAt: Date.now(), delivery: reply.failed === true ? 'none' : 'sending' })
      this.logger.info(`turn for ${key} settled in ${Date.now() - record.startedAt}ms (${reply.text.length} chars)`)
      if (reply.failed === true) {
        this.logger.warn(`turn failed for ${key}: ${reply.text}`)
        await this.send(message, { text: reply.interrupted === true ? '任务等待超时，执行结束未确认。请先在桌面核对，再决定是否重试。可用 /status 查看状态。' : '任务执行失败，执行是否已产生效果请先核对，再决定是否重试。可用 /status 查看状态。', kind: 'notice' })
        return
      }
      const results: SendResult[] = []
      if (reply.text.trim() !== '') results.push(...await this.send(message, { text: reply.text, kind: 'reply' }, taskId))
      // Preserve files even when the text is waiting for retry; do not claim they were sent.
      if (!results.some((result) => !result.ok) && outputDir !== undefined && !this.#disposed) results.push(...await this.#sendProducedFiles(message, outputDir, taskId))
      if (results.length === 0) results.push(...await this.send(message, { text: '任务已完成，没有返回文字或文件。', kind: 'reply' }, taskId))
      const pending = this.#outbox.list().some((entry) => entry.taskId === taskId)
      const unconfirmed = results.some((result) => result.ok && result.unconfirmed)
      let filesUnsent = false
      if (results.some((result) => !result.ok) && outputDir !== undefined) {
        try { filesUnsent = fs.readdirSync(outputDir).length > 0 } catch { filesUnsent = true }
      }
      const delivery = pending ? 'pending' : results.some((result) => !result.ok) ? 'failed' : results.some((result) => result.ok && result.unconfirmed) ? 'unknown' : 'sent'
      this.#tasks.update(message, taskId, { delivery, unconfirmed, filesUnsent })
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
      this.#outbox.add(target, { kind: 'reply', text: bubbles[0]! }, { code: 'queued', remaining: bubbles.slice(1), taskId })
      return [{ ok: false, code: 'queued' }]
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
        if (outgoing.kind === 'reply') this.#outbox.add(target, { kind: 'reply', text: bubble }, { id, code: result.code, remaining: bubbles.slice(index + 1), taskId })
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
      return []
    }
    if (files.length === 0) return []
    const media = files
      .filter((file) => file.bytes > 0)
      .map((file) => ({ kind: 'file' as const, path: file.path, name: file.name, bytes: file.bytes }))
    if (media.length === 0) return []
    this.#options.logger.info(`sending ${media.length} produced file(s)`)
    return this.send(message, { kind: 'reply', media }, taskId)
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
          return result.ok === true ? { ok: true as const } : { ok: false as const, code: result.code }
        })
        .then(() => {
          for (const task of retryTasks.values()) {
            if (this.#outbox.list().some((entry) => entry.taskId === task.id && sameTarget(entry.target, task.target))) continue
            const saved = this.#tasks.latest(task.target)
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

function statusPreview(text: string, limit: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '))
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('')
}
