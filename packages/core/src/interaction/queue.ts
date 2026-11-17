/**
 * One blocking interaction at a time, per conversation.
 *
 * Two DSH seams pause an agent to ask the person something: `user-questions`
 * (a question with options) and `approval` (may I run this tool). Both are
 * one-shot, both are answered by a reply in the same chat, and a chat has no
 * threading — two live prompts would both say "1. … 2. …" and one reply could
 * not say which it meant. So they share this queue.
 *
 * The queue owns the mechanics (present, wait, timeout, queue, dispose); each
 * seam owns the vocabulary (render a prompt, parse a reply). It never invents a
 * result: a timeout or a withdrawal rejects, and the caller decides whether
 * another surface can still take over.
 *
 * @module @rodin/dsh-channels/interaction/queue
 */
import type { Outgoing, SendResult, Target } from '../types.js'

export const DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60_000

export type InteractionKind = 'question' | 'approval'

export interface InteractionEntry {
  kind: InteractionKind
  target: Target
  /** The prompt, as the adapter wants it rendered. */
  view: {
    title: string
    options: { id: string; label: string }[]
    hint?: string
  }
  /** Parse one reply text; `null` means "not an answer, ask again". */
  parse(text: string): { ok: true; value: string } | { ok: false; hint: string } | null
  /** A free-text prompt cannot distinguish its answer from ordinary chat before delivery. */
  freeText?: boolean
  /** Sent when the wait runs out. */
  expiredNotice: string
  /** Sent when another surface answered first. */
  retiredNotice: string
  /** What a retired entry resolves to; the caller ignores it. */
  retireValue: string
}

interface Pending {
  entry: InteractionEntry
  started: boolean
  resolve(value: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | undefined
  offAbort: () => void
}

interface Transmission {
  done: Promise<unknown>
  retired: InteractionEntry[]
}

export interface InteractionQueueOptions {
  /** Send one rendered prompt (the runtime's normal send path). */
  send(target: Target, outgoing: Outgoing): Promise<readonly SendResult[]>
  logger: { info: (line: string) => void; warn: (line: string) => void }
  timeoutMs?: number | (() => number)
}

function keyOf(target: Target): string {
  return `${target.channel}|${target.accountId}|${target.conversationId}`
}

function timedOutError(kind: InteractionKind): Error {
  const error = new Error(`the ${kind} expired in the chat`)
  ;(error as NodeJS.ErrnoException).code = 'ETIMEDOUT'
  return error
}

function withdrawnError(kind: InteractionKind): Error {
  const error = new Error(`the ${kind} was withdrawn before it was answered`)
  ;(error as NodeJS.ErrnoException).code = 'ETIMEDOUT'
  return error
}

export class InteractionQueue {
  readonly #options: InteractionQueueOptions
  /** conversation key → the entries waiting, head first. */
  readonly #queues = new Map<string, Pending[]>()
  readonly #transmissions = new Map<string, Transmission>()
  #disposed = false

  constructor(options: InteractionQueueOptions) {
    this.#options = options
  }

  #timeoutMs(): number {
    const configured = typeof this.#options.timeoutMs === 'function' ? this.#options.timeoutMs() : this.#options.timeoutMs
    return Number.isFinite(configured) && (configured as number) > 0 ? (configured as number) : DEFAULT_INTERACTION_TIMEOUT_MS
  }

  /** The interaction this conversation is currently being asked, if any. */
  active(target: Target): InteractionKind | undefined {
    return this.#queues.get(keyOf(target))?.[0]?.entry.kind
  }

  /** How many conversations have an active interaction. */
  pendingCount(): number {
    let total = 0
    for (const list of this.#queues.values()) total += list.length > 0 ? 1 : 0
    return total
  }

  /** True while an interaction or its prompt transmission is active. */
  busy(target: Target): boolean {
    return this.active(target) !== undefined || this.#transmissions.has(keyOf(target))
  }

  /** Queue one interaction and resolve with the answer the person gave. */
  ask(entry: InteractionEntry, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('the interaction queue is disposed'))
    if (signal?.aborted === true) return Promise.reject(withdrawnError(entry.kind))
    const key = keyOf(entry.target)
    const list = this.#queues.get(key) ?? []
    this.#queues.set(key, list)

    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        entry,
        started: false,
        resolve,
        reject,
        timer: undefined,
        offAbort: () => {},
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#settle(pending, undefined, withdrawnError(entry.kind))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.offAbort = () => signal.removeEventListener('abort', onAbort)
      }
      list.push(pending)
      if (list.length === 1) this.#present(pending)
    })
  }

  #sendInOrder(target: Target, send: () => Promise<unknown>): void {
    const key = keyOf(target)
    // Retirement settles the request immediately, but a newer prompt must not overtake its delivery.
    const previous = this.#transmissions.get(key)
    const done = (previous?.done ?? Promise.resolve()).then(() => this.#disposed ? undefined : send()).catch(() => {})
    const current = { done, retired: previous?.retired ?? [] }
    this.#transmissions.set(key, current)
    void done.then(() => {
      if (this.#transmissions.get(key) === current) this.#transmissions.delete(key)
    })
  }

  /** Send the head entry's prompt and arm its timer. */
  #present(pending: Pending): void {
    const { entry } = pending
    this.#sendInOrder(entry.target, async () => {
      if (!this.#isHead(pending)) return
      pending.started = true
      try {
        const results = await this.#options.send(entry.target, { text: this.#renderText(entry), kind: 'question' })
        const failed = results.find((result) => result.ok === false)
        if (failed !== undefined) throw new Error(failed.detail ?? failed.code)
        if (results.length === 0) throw new Error('nothing was sent')
      } catch (error) {
        // Fail fast so another surface can answer a prompt the chat could not deliver.
        this.#settle(pending, undefined, new Error(`could not deliver the ${entry.kind}: ${String((error as Error)?.message ?? error)}`))
        return
      }
      if (!this.#isHead(pending)) return
      const transmission = this.#transmissions.get(keyOf(entry.target))
      if (transmission !== undefined) transmission.retired.length = 0
      pending.timer = setTimeout(() => {
        this.#settle(pending, undefined, timedOutError(entry.kind), entry.expiredNotice)
      }, this.#timeoutMs())
      pending.timer.unref?.()
    })
  }

  /**
   * The prompt text. The numbering IS the answer syntax, so it is generated in
   * one place (here) rather than by each seam.
   */
  #renderText(entry: InteractionEntry): string {
    const lines = [entry.view.title]
    if (entry.view.options.length > 0) {
      entry.view.options.forEach((option, index) => {
        lines.push(`${index + 1}. ${option.label}`)
      })
    }
    if (entry.view.hint !== undefined && entry.view.hint !== '') lines.push('', entry.view.hint)
    const minutes = Math.max(1, Math.round(this.#timeoutMs() / 60_000))
    lines.push('', `（回复序号即可，${minutes} 分钟内有效）`)
    return lines.join('\n')
  }

  #isHead(pending: Pending): boolean {
    return this.#queues.get(keyOf(pending.entry.target))?.[0] === pending
  }

  /**
   * Try to read one inbound message as the answer to the active interaction.
   *
   * Returns 'none' when nothing is being asked; the caller then starts a turn.
   * 'waiting' discards replies to numbered prompts during delivery.
   * An unparsable reply does NOT consume the interaction: the person gets a hint
   * and can try again.
   */
  claim(target: Target, text: string): { status: 'none' | 'waiting' | 'answered' } | { status: 'invalid'; hint: string } {
    const key = keyOf(target)
    const head = this.#queues.get(key)?.[0]
    if (head?.timer === undefined) {
      const isAnswer = (entry: InteractionEntry) => entry.freeText !== true && entry.parse(text)?.ok === true
      const stale = this.#transmissions.get(key)?.retired
      return { status: (head !== undefined && isAnswer(head.entry)) || stale?.some(isAnswer) ? 'waiting' : 'none' }
    }
    const parsed = head.entry.parse(text)
    if (parsed === null) return { status: 'none' }
    if (parsed.ok !== true) return { status: 'invalid', hint: parsed.hint }
    this.#settle(head, parsed.value)
    return { status: 'answered' }
  }

  /** Another surface answered first: tell the person and resolve. */
  retire(entry: InteractionEntry): void {
    const pending = this.#queues.get(keyOf(entry.target))?.find((item) => item.entry === entry)
    if (pending !== undefined) this.#settle(pending, entry.retireValue, undefined, entry.retiredNotice)
  }

  #settle(pending: Pending, value?: string, error?: Error, notice?: string): void {
    const key = keyOf(pending.entry.target)
    const list = this.#queues.get(key)
    if (list === undefined) return
    const index = list.indexOf(pending)
    if (index === -1) return
    list.splice(index, 1)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.offAbort()
    if (list.length === 0) this.#queues.delete(key)
    if (pending.started && notice !== undefined && notice !== '') {
      this.#sendInOrder(pending.entry.target, () => this.#options.send(pending.entry.target, { text: notice, kind: 'notice' }))
    }
    const next = list[0]
    if (index === 0 && next !== undefined && !this.#disposed) this.#present(next)
    if (pending.started) this.#transmissions.get(key)?.retired.push(pending.entry)
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value ?? pending.entry.retireValue)
  }

  /** Drop everything (plugin unload). Every waiting promise rejects. */
  dispose(): void {
    this.#disposed = true
    for (const list of [...this.#queues.values()]) {
      for (const pending of [...list]) this.#settle(pending, undefined, new Error('the interaction queue is disposed'))
    }
    this.#queues.clear()
    this.#transmissions.clear()
  }
}
