/**
 * Durable fixed-window counters.
 *
 * The rate gates are a safety bound: a bug that loops a send must not become a
 * hundred messages, and a restart must not reset the day's quota — the
 * reference implementation's `senderPerDay` was meaningless because its counters
 * lived in memory. So the count is persisted, keyed by window, and read back on
 * startup.
 *
 * Writes are write-through: the in-memory map is authoritative for reads (a gate
 * must answer synchronously) and the durable copy catches up. A failed durable
 * write is logged, never thrown into the message path — a counter that cannot be
 * saved must not refuse a person's message.
 *
 * @module @derekluo/dsh-channels/store/counters
 */
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJson } from './atomic.js'

export interface CounterStore {
  /** Read the count for a window key; 0 when absent. */
  get(key: string): number
  /** Set the count, write-through. */
  set(key: string, value: number): void
  /** Load the durable copy (once, at startup). */
  load(): Promise<void>
}

/** A counter file next to the rest of the plugin state. */
export class FileCounterStore implements CounterStore {
  readonly #file: string
  readonly #warn: (line: string) => void
  readonly #values = new Map<string, number>()
  #dirty = false

  constructor({ stateRoot, warn = () => {} }: { stateRoot: string; warn?: (line: string) => void }) {
    this.#file = path.join(stateRoot, 'counters.json')
    this.#warn = warn
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) this.#values.set(key, value)
      }
    } catch {
      // No file yet, or a malformed one: an empty count is the safe start.
    }
  }

  get(key: string): number {
    return this.#values.get(key) ?? 0
  }

  set(key: string, value: number): void {
    this.#values.set(key, value)
    this.#dirty = true
    this.flush()
  }

  /** Persist now; called on every write because the file is small and rare. */
  flush(): boolean {
    if (!this.#dirty) return true
    const ok = atomicWriteJson(this.#file, Object.fromEntries(this.#values), { mode: 0o600, warn: this.#warn })
    if (ok) this.#dirty = false
    return ok
  }
}

/** The slice of a domain table this store needs. */
export interface CounterTable {
  get: (key: string) => { count?: number } | undefined
  put: (key: string, value: { count: number }) => Promise<unknown>
}

/** The same store over the host's `channels` storage domain. */
export class DomainCounterStore implements CounterStore {
  readonly #table: CounterTable
  readonly #warn: (line: string) => void
  readonly #values = new Map<string, number>()

  constructor({ table, warn = () => {} }: { table: CounterTable; warn?: (line: string) => void }) {
    this.#table = table
    this.#warn = warn
  }

  async load(): Promise<void> {
    // The domain has no "list all keys" in the synchronous read the gate needs,
    // and a counter row nobody read is the same as a zero; the first take of a
    // window reads its row on demand below.
  }

  get(key: string): number {
    const cached = this.#values.get(key)
    if (cached !== undefined) return cached
    try {
      const record = this.#table.get(key)
      const count = typeof record?.count === 'number' ? record.count : 0
      this.#values.set(key, count)
      return count
    } catch (error) {
      this.#warn(`counter read failed for ${key}: ${String((error as Error)?.message ?? error)}`)
      return 0
    }
  }

  set(key: string, value: number): void {
    this.#values.set(key, value)
    // Write-through, and a failure is a warning: a counter that cannot be saved
    // must not refuse a person's message.
    void Promise.resolve()
      .then(() => this.#table.put(key, { count: value }))
      .catch((error: unknown) => this.#warn(`counter write failed for ${key}: ${String((error as Error)?.message ?? error)}`))
  }
}
