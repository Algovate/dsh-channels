/**
 * One FIFO per conversation, plus a way for an interaction reply to jump it.
 *
 * Two properties matter and both are tested:
 *  - two messages in one conversation never run at the same time (the agent
 *    session is not re-entrant), while different conversations run in parallel;
 *  - an answer to a question runs *now*, not behind the turn that is asking it.
 *    Queueing that answer behind its own question deadlocks until the timeout.
 *
 * @module @rodin/dsh-channels/inbound/queue
 */

export interface QueueTask<T = unknown> {
  run(signal: AbortSignal): Promise<T>
}

/** A task, either as an object or as a bare function. */
export type QueueWork<T = unknown> = QueueTask<T> | ((signal: AbortSignal) => Promise<T>)

interface Tail {
  /** Resolves when the tail of this conversation's queue settles. */
  promise: Promise<void>
  controller: AbortController
}

export class ConversationQueue {
  #tails = new Map<string, Tail>()

  /** Append a task; resolves with its result once everything before it settled. */
  push<T>(key: string, work: QueueWork<T>): Promise<T> {
    const task: QueueTask<T> = typeof work === 'function' ? { run: work } : work
    const previous = this.#tails.get(key)
    const controller = new AbortController()
    const start = (previous?.promise ?? Promise.resolve()).then(() => task.run(controller.signal))
    const settled = start.then(
      () => undefined,
      () => undefined,
    )
    const tail: Tail = { promise: settled, controller }
    this.#tails.set(key, tail)
    void settled.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return start
  }

  /** Run a task immediately, in parallel with whatever the conversation is doing. */
  runNow<T>(work: QueueWork<T>): Promise<T> {
    const task: QueueTask<T> = typeof work === 'function' ? { run: work } : work
    return task.run(new AbortController().signal)
  }

  /** Abort the queued work of one conversation (the running task sees the signal). */
  abort(key: string, reason = 'aborted'): void {
    const tail = this.#tails.get(key)
    if (tail === undefined) return
    tail.controller.abort(reason)
  }

  /** Number of conversations with queued or running work. */
  size(): number {
    return this.#tails.size
  }

  /** True when this conversation has work in flight. */
  busy(key: string): boolean {
    return this.#tails.has(key)
  }
}
