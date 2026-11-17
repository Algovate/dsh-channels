/**
 * Text that could not be delivered, kept until it can be retried.
 *
 * A channel that silently drops a reply is indistinguishable from an agent that
 * never answered, so a failed send is written here, retried with backoff, and
 * shown as backlog. Bounded: an outbox that grows without limit is a second bug.
 *
 * @module @rodin/dsh-channels/store/outbox
 */
import path from 'node:path'

import { atomicWriteJson, readJsonFile } from './atomic.js'

export interface OutboxEntry {
  id: string
  target: { channel: string; accountId: string; conversationId: string }
  outgoing: { text?: string; kind: 'reply' | 'notice' | 'question' }
  attempts: number
  nextAt: number
  lastCode?: string
}

interface OutboxFile {
  schemaVersion: 1
  items: OutboxEntry[]
}

/** Backoff after the n-th failure: 30s, 2m, 10m, then a fixed 30m. */
export function backoffMs(attempts: number): number {
  if (attempts <= 1) return 30_000
  if (attempts === 2) return 120_000
  if (attempts === 3) return 600_000
  return 1_800_000
}

export class Outbox {
  readonly #file: string
  readonly #max: number
  readonly #warn: (line: string) => void
  readonly #now: () => number
  #draining = false

  constructor({ stateRoot, max = 50, warn = () => {}, now = Date.now }: { stateRoot: string; max?: number; warn?: (line: string) => void; now?: () => number }) {
    this.#file = path.join(stateRoot, 'outbox.json')
    this.#max = max
    this.#warn = warn
    this.#now = now
  }

  #read(): OutboxEntry[] {
    const store = readJsonFile<OutboxFile>(this.#file, () => ({ schemaVersion: 1, items: [] }), this.#warn)
    return Array.isArray(store.items) ? store.items : []
  }

  #write(items: OutboxEntry[]): void {
    atomicWriteJson(this.#file, { schemaVersion: 1, items } satisfies OutboxFile, { warn: this.#warn })
  }

  /** Append a failed send. Oldest entries are dropped once the bound is reached. */
  add(target: OutboxEntry['target'], outgoing: OutboxEntry['outgoing'], result: { code?: string; id?: string }): OutboxEntry | undefined {
    const text = outgoing.text ?? ''
    if (text.trim() === '' || outgoing.kind !== 'reply') return undefined
    const items = this.#read()
    if (items.length >= this.#max) items.shift()
    const entry: OutboxEntry = {
      id: result.id ?? `out-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target,
      outgoing,
      attempts: 0,
      nextAt: this.#now() + backoffMs(1),
      ...(result.code === undefined ? {} : { lastCode: result.code }),
    }
    items.push(entry)
    this.#write(items)
    return entry
  }

  list(): OutboxEntry[] {
    return this.#read()
  }

  drop(id: string): boolean {
    const items = this.#read()
    const kept = items.filter((entry) => entry.id !== id)
    if (kept.length === items.length) return false
    this.#write(kept)
    return true
  }

  /** Retry every entry whose backoff elapsed. Returns how many were delivered. */
  async drain(send: (entry: OutboxEntry) => Promise<{ ok: boolean; code?: string }>): Promise<number> {
    if (this.#draining) return 0
    this.#draining = true
    try {
      let delivered = 0
      for (const candidate of this.#read()) {
        if (candidate.nextAt > this.#now() || !this.#read().some((entry) => entry.id === candidate.id)) continue
        let result: { ok: boolean; code?: string }
        try {
          result = await send(candidate)
        } catch (error) {
          this.#warn(`outbox retry failed: ${String(error)}`)
          result = { ok: false, code: 'retry-threw' }
        }
        const items = this.#read()
        const index = items.findIndex((entry) => entry.id === candidate.id)
        if (result.ok) delivered += 1
        if (index === -1) continue
        if (result.ok) items.splice(index, 1)
        else {
          const entry = items[index]!
          entry.attempts += 1
          entry.nextAt = this.#now() + backoffMs(entry.attempts + 1)
          if (result.code !== undefined) entry.lastCode = result.code
        }
        this.#write(items)
      }
      return delivered
    } finally {
      this.#draining = false
    }
  }
}
