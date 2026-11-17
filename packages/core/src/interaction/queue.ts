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
import type { Outgoing, Target } from '../types.js'

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
  /** Sent when the wait runs out. */
  expiredNotice: string
  /** Sent when another surface answered first. */
  retiredNotice: string
  /** What a retired entry resolves to; the caller ignores it. */
  retireValue: string
}

interface Pending {
  entry: InteractionEntry
  resolve(value: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | undefined
  offAbort: () => void
}

export interface InteractionQueueOptions {
  /** Send one rendered prompt (the runtime's normal send path). */
  send(target: Target, outgoing: Outgoing): Promise<unknown>
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

  /** True when a prompt is on screen for this conversation. */
  busy(target: Target): boolean {
    return this.active(target) !== undefined
  }

  /** Queue one interaction and resolve with the answer the person gave. */
  ask(entry: InteractionEntry, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('the interaction queue is disposed'))
    const key = keyOf(entry.target)
    const list = this.#queues.get(key) ?? []
    this.#queues.set(key, list)

    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        entry,
        resolve,
        reject,
        timer: undefined,
        offAbort: () => {},
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#remove(pending, withdrawnError(entry.kind))
        }
        if (signal.aborted) {
          queueMicrotask(onAbort)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.offAbort = () => signal.removeEventListener('abort', onAbort)
      }
      list.push(pending)
      if (list.length === 1) void this.#present(pending)
    })
  }

  /** Send the head entry's prompt and arm its timer. */
  async #present(pending: Pending): Promise<void> {
    const { entry } = pending
    const outgoing: Outgoing = {
      text: this.#renderText(entry),
      kind: 'question',
    }
    try {
      await this.#options.send(entry.target, outgoing)
    } catch (error) {
      // A prompt that never reached the person cannot be answered; fail fast
      // so the seam can fall back to another surface instead of waiting 10m.
      this.#settle(pending, undefined, new Error(`could not deliver the ${entry.kind}: ${String((error as Error)?.message ?? error)}`))
      return
    }
    if (pending.timer !== undefined || !this.#isHead(pending)) return
    pending.timer = setTimeout(() => {
      this.#settle(pending, undefined, timedOutError(entry.kind), entry.expiredNotice)
    }, this.#timeoutMs())
    pending.timer.unref?.()
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
   * An unparsable reply does NOT consume the interaction: the person gets a hint
   * and can try again.
   */
  claim(target: Target, text: string): { status: 'none' } | { status: 'answered' } | { status: 'invalid'; hint: string } {
    const head = this.#queues.get(keyOf(target))?.[0]
    if (head === undefined) return { status: 'none' }
    const parsed = head.entry.parse(text)
    if (parsed === null) return { status: 'none' }
    if (parsed.ok !== true) return { status: 'invalid', hint: parsed.hint }
    this.#settle(head, parsed.value)
    return { status: 'answered' }
  }

  /** Another surface answered first: tell the person and resolve. */
  retire(target: Target): void {
    const head = this.#queues.get(keyOf(target))?.[0]
    if (head === undefined) return
    this.#settle(head, head.entry.retireValue, undefined, head.entry.retiredNotice)
  }

  #remove(pending: Pending, error: Error): void {
    this.#settle(pending, undefined, error)
  }

  #settle(pending: Pending, value?: string, error?: Error, notice?: string): void {
    const list = this.#queues.get(keyOf(pending.entry.target))
    if (list === undefined) return
    const index = list.indexOf(pending)
    if (index === -1) return
    list.splice(index, 1)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.offAbort()
    if (list.length === 0) this.#queues.delete(keyOf(pending.entry.target))
    else void this.#present(list[0] as Pending)
    if (notice !== undefined && notice !== '') {
      void this.#options.send(pending.entry.target, { text: notice, kind: 'notice' }).catch(() => {})
    }
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
  }
}
