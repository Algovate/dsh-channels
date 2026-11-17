/** Cancellable FIFO per conversation; interaction answers bypass it in the runtime. */

interface Tail {
  /** Resolves when the tail of this conversation's queue settles. */
  promise: Promise<void>
}

export class ConversationQueue {
  readonly #controllers = new Map<AbortController, string>()
  #disposed = false
  #tails = new Map<string, Tail>()

  /** Append a task; resolves with its result once everything before it settled. */
  push<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error('the conversation queue is disposed'))
    const previous = this.#tails.get(key)
    const controller = new AbortController()
    this.#controllers.set(controller, key)
    const start = (previous?.promise ?? Promise.resolve()).then(() => {
      controller.signal.throwIfAborted()
      return work(controller.signal)
    })
    const settled = start.then(
      () => undefined,
      () => undefined,
    )
    const tail: Tail = { promise: settled }
    this.#tails.set(key, tail)
    void settled.then(() => {
      this.#controllers.delete(controller)
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return start
  }

  /** Abort the queued work of one conversation (the running task sees the signal). */
  abort(key: string, reason = 'aborted'): void {
    for (const [controller, conversation] of this.#controllers) {
      if (conversation === key) controller.abort(reason)
    }
  }

  dispose(): void {
    this.#disposed = true
    for (const controller of this.#controllers.keys()) controller.abort('disposed')
    this.#controllers.clear()
    this.#tails.clear()
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
