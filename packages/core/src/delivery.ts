/** Durable outbound delivery; ingress and turn execution remain in the runtime. */
import { setTimeout as delay } from 'node:timers/promises'
import { snapshotDelivery, type ArtifactDelivery } from './artifacts.js'
import type { ChannelsConfig } from './config.js'
import { plainText, splitIntoBubbles } from './outbound.js'
import type { ChannelRoutes } from './routing.js'
import { Outbox, type OutboxEntry } from './store/outbox.js'
import type { Journal } from './store/journal.js'
import type { Tasks, TaskRecord } from './store/tasks.js'
import type { ChannelAdapter, InboundMessage, Outgoing, SendResult, Target } from './types.js'

interface DeliveryOptions {
  config: ChannelsConfig
  logger: { info(line: string): void; warn(line: string): void }
  stateRoot: string
  adapters: ReadonlyMap<string, ChannelAdapter>
  tasks: Tasks
  routes: ChannelRoutes
  journal: Journal
  authorized(message: InboundMessage): boolean
  canDeliverSchedule(id: string, target: Target): Promise<boolean>
}

export class Delivery {
  readonly #options: DeliveryOptions
  readonly #outbox: Outbox
  #disposed = false

  constructor(options: DeliveryOptions) {
    this.#options = options
    this.#outbox = new Outbox({ stateRoot: options.stateRoot, warn: options.logger.warn,
      commitProgress: (file, entry, result, finished) => options.tasks.recordDelivery(file, entry, result, finished),
    })
  }

  get outbox(): Outbox { return this.#outbox }
  private get config(): ChannelsConfig { return this.#options.config }
  private get logger(): DeliveryOptions['logger'] { return this.#options.logger }

  /** Persist replies before sending; ephemeral notices and prompts send directly. */
  async send(target: Target, outgoing: Outgoing, taskId?: string): Promise<SendResult[]> {
    if (this.#disposed) return [{ ok: false, code: 'stopped' }]
    if (!this.#taskDeliveryAllowed(target, taskId)) return [{ ok: false, code: 'task-delivery-blocked' }]
    const adapter = this.#options.adapters.get(target.channel)
    if (adapter === undefined) return [{ ok: false, code: 'unknown-channel', detail: target.channel }]
    const scheduledId = taskId?.startsWith('schedule:') ? taskId : undefined
    if (scheduledId !== undefined && !await this.#options.canDeliverSchedule(scheduledId, target)) return [{ ok: false, code: 'schedule-delivery-cancelled' }]
    if (this.#disposed) return [{ ok: false, code: 'stopped' }]
    const text = outgoing.text === undefined ? '' : plainText(outgoing.text)
    const limit = Number.isFinite(adapter.capabilities.maxTextChars) && adapter.capabilities.maxTextChars > 0 ? adapter.capabilities.maxTextChars : this.config.maxTextChars
    const bubbles = splitIntoBubbles(text, limit)
    const actions = outgoing.actions !== undefined && adapter.capabilities.actions === true ? outgoing.actions : undefined
    const results: SendResult[] = []
    if (outgoing.kind === 'reply' && bubbles.length > 0) {
      results.push(...await this.enqueueReply(target, outgoing.text ?? '', taskId))
      if (results.some((result) => !result.ok)) return results
    }
    const base = { kind: outgoing.kind }
    for (const [index, bubble] of (outgoing.kind === 'reply' ? [] : bubbles).entries()) {
      if (index > 0 && this.config.bubbleGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.config.bubbleGapMs))
      if (this.#disposed) return [...results, { ok: false, code: 'stopped' }]
      // Delivery authorization is checked once per batch (above); re-reading the
      // native catalog for every bubble made a long reply O(bubbles) round trips.
      const id = `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const result = await this.#deliver(adapter, target, {
        ...base,
        text: bubble,
        ...(index === 0 && actions !== undefined ? { actions } : {}),
      }, bubble, id)
      results.push(result)
      if (!result.ok) return results
    }
    for (const item of outgoing.media ?? []) {
      if (this.#disposed) return [...results, { ok: false, code: 'stopped' }]
      // Manual sends carry temporary paths; automatic task files use durable artifact references.
      const result = await this.#deliver(adapter, target, { kind: outgoing.kind, text: '', media: [item] }, '')
      results.push(result)
    }
    return results
  }

  async enqueueReply(target: Target, text: string, taskId?: string, attachments: ArtifactDelivery[] = [], completion: Partial<TaskRecord> = {}): Promise<SendResult[]> {
    if (this.#disposed) return [{ ok: false, code: 'stopped' }]
    if (!this.#taskDeliveryAllowed(target, taskId)) return [{ ok: false, code: 'task-delivery-blocked' }]
    const adapter = this.#options.adapters.get(target.channel)
    if (!adapter) return [{ ok: false, code: 'unknown-channel' }]
    const limit = adapter.capabilities.maxTextChars > 0 ? adapter.capabilities.maxTextChars : this.config.maxTextChars
    const parts = splitIntoBubbles(plainText(text), limit).filter((part) => part.trim() !== '')
    if (!parts.length && !attachments.length) return []
    const entry = this.#outbox.enqueue(target, parts, taskId,
      taskId !== undefined && this.#options.tasks.get(target, taskId)?.recovery !== undefined
        ? (file) => this.#options.tasks.handoffDelivery(target, taskId, file, completion) : undefined, attachments)
    if (!entry) return [{ ok: false, code: 'outbox-persist' }]
    return this.#outbox.sendPending(entry, (pending) => this.#sendPending(pending))
  }

  /** Update the task card in place; `false` means the channel cannot edit, so send a notice instead. */
  async editCard(message: InboundMessage, card: { messageId: string }, text: string): Promise<boolean> {
    const adapter = this.#options.adapters.get(message.channel)
    if (adapter === undefined || adapter.capabilities.edit !== true || typeof adapter.edit !== 'function') return false
    try {
      const result = await adapter.edit(message, card.messageId, { kind: 'notice', text })
      if (!result.ok) {
        this.logger.info(`task card edit was not accepted: ${result.code}`)
        return false
      }
      return true
    } catch (error) {
      this.logger.warn(`task card edit failed: ${String(error)}`)
      return false
    }
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
    this.#options.journal.append({ ...base, phase: 'sending' })
    let result: SendResult
    try {
      result = await adapter.send(target, outgoing)
    } catch (error) {
      result = { ok: false, code: 'adapter-threw', detail: String((error as Error)?.message ?? error) }
    }
    this.#options.journal.append({
      ...base,
      phase: 'settled',
      delivery: result.ok === true ? (result.unconfirmed === true ? 'unconfirmed' : 'accepted') : 'failed',
      ...(result.ok === true && result.messageId !== undefined ? { messageId: result.messageId } : {}),
      ...(result.ok === true ? {} : { code: result.code, id }),
    })
    return result
  }

  #taskDeliveryAllowed(target: Target, taskId?: string): boolean {
    if (taskId === undefined || taskId.startsWith('schedule:')) return true
    const task = this.#options.tasks.get(target, taskId)
    if (task === undefined) return false
    const message: InboundMessage = { ...target, senderId: task.senderId, text: '', media: [], group: false, at: 0 }
    return this.#options.authorized(message)
      && (task.project === undefined ? this.#options.routes.artifactWorkspace(task) !== undefined
        : this.#options.routes.acceptsQueued({ id: task.id, message, sessionId: '', project: task.project, workingDirectory: task.workingDirectory }))
  }

  async #sendPending(entry: OutboxEntry): Promise<SendResult> {
    const adapter = this.#options.adapters.get(entry.target.channel)
    if (adapter === undefined) return { ok: false, code: 'unknown-channel' }
    if (this.#disposed) return { ok: false, code: 'stopped' }
    let accounts
    try { accounts = await adapter.accounts.list() }
    catch { return { ok: false, code: 'account-unavailable' } }
    if (!accounts.some((account) => account.accountId === entry.target.accountId && !account.expired)) return { ok: false, code: 'account-unavailable' }
    if ((entry.part ?? 0) > 0 && this.config.bubbleGapMs > 0) await delay(this.config.bubbleGapMs)
    if (this.#disposed || this.#options.adapters.get(entry.target.channel) !== adapter) return { ok: false, code: 'stopped' }
    if (entry.taskId?.startsWith('schedule:') && !await this.#options.canDeliverSchedule(entry.taskId, entry.target)) {
      return { ok: false, code: this.#outbox.drop(entry.id) ? 'schedule-delivery-cancelled' : 'outbox-persist' }
    }
    if (this.#disposed) return { ok: false, code: 'stopped' }
    if (!this.#taskDeliveryAllowed(entry.target, entry.taskId)) return { ok: false, code: 'task-delivery-blocked' }
    let outgoing: Outgoing = { kind: entry.outgoing.kind, text: entry.outgoing.text }
    let copy: Awaited<ReturnType<typeof snapshotDelivery>>
    const artifact = entry.outgoing.artifact
    if (artifact !== undefined) {
      if (!this.config.autoSendFiles) return { ok: false, code: 'files-disabled' }
      const task = entry.taskId === undefined ? undefined : this.#options.tasks.get(entry.target, entry.taskId)
      const workspace = task === undefined ? undefined : this.#options.routes.artifactWorkspace(task)
      if (!task?.outputDirectory || !workspace || !task.artifacts?.includes(artifact.relative)) return { ok: false, code: 'artifact-unavailable' }
      copy = await snapshotDelivery(workspace, task.outputDirectory, artifact, this.config.maxProducedBytes)
      if (!copy) return { ok: false, code: 'artifact-unavailable' }
      outgoing = { kind: 'reply', media: [{ kind: artifact.kind, path: copy.path, name: artifact.name }] }
    }
    let result: SendResult
    try {
      if (this.#disposed) return { ok: false, code: 'stopped' }
      if (artifact && !this.config.autoSendFiles) return { ok: false, code: 'files-disabled' }
      if (!this.#taskDeliveryAllowed(entry.target, entry.taskId)) return { ok: false, code: 'task-delivery-blocked' }
      const task = entry.taskId === undefined ? undefined : this.#options.tasks.get(entry.target, entry.taskId)
      if (task?.replyMessage !== undefined) adapter.restoreInbound?.({ ...task.replyMessage, ...entry.target, senderId: task.senderId })
      result = await this.#deliver(adapter, entry.target, outgoing, entry.outgoing.text ?? '', entry.part === undefined ? entry.id : `${entry.id}:${entry.part}`)
    } finally { await copy?.dispose() }
    return result.ok && entry.unconfirmed ? { ...result, unconfirmed: true } : result
  }

  retry(): Promise<number> {
    return this.#outbox.drain((entry) => this.#sendPending(entry))
  }

  dispose(): void { this.#disposed = true }
}
