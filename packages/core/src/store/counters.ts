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
import { stateFile, type StateFile } from './state.js'

export interface CounterStore {
  /** Read the count for a window key; 0 when absent. */
  get(key: string): number
  /** Set the count, write-through. */
  set(key: string, value: number): void
  /** Load the durable copy (once, at startup). */
  load(): Promise<void>
}

interface CounterRecord { count: number; windowStart?: number }

// One row per subject/window type, rather than one permanent row per minute.
function location(key: string): { key: string; windowStart?: number } {
  const match = /^(minute|day):(.+):(\d+)$/.exec(key)
  return match === null ? { key } : { key: `quota:${match[1]}:${match[2]}`, windowStart: Number(match[3]) }
}
function countAt(record: CounterRecord | undefined, windowStart: number | undefined): number {
  return record?.windowStart === windowStart ? record?.count ?? 0 : 0
}

/** A compact counter file next to the rest of the plugin state. */
export class FileCounterStore implements CounterStore {
  readonly #store: StateFile
  readonly #warn: (line: string) => void
  readonly #values = new Map<string, CounterRecord>()
  #dirty = false

  constructor({ stateRoot, warn = () => {} }: { stateRoot: string; warn?: (line: string) => void }) {
    this.#store = stateFile(stateRoot, warn)
    this.#warn = warn
  }
  async load(): Promise<void> {
    try {
      const parsed: unknown = this.#store.read<unknown>('counters')
      if (parsed === undefined) return
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed)) {
        const loc = location(key)
        const record = typeof value === 'number' ? { count: value, ...(loc.windowStart === undefined ? {} : { windowStart: loc.windowStart }) } : value as CounterRecord | null
        if (typeof record?.count !== 'number' || !Number.isFinite(record.count) || record.count < 0) continue
        if (record.windowStart !== undefined && !Number.isFinite(record.windowStart)) continue
        const previous = this.#values.get(loc.key)
        if (previous === undefined || (record.windowStart ?? 0) >= (previous.windowStart ?? 0)) this.#values.set(loc.key, record)
      }
      this.#dirty = true
      this.flush()
    } catch { /* No durable copy yet. */ }
  }
  get(key: string): number {
    const loc = location(key)
    return countAt(this.#values.get(loc.key), loc.windowStart)
  }
  set(key: string, value: number): void {
    const loc = location(key)
    const previous = this.#values.get(loc.key)
    // A delayed reservation from an older window cannot overwrite the current quota.
    if (loc.windowStart !== undefined && (previous?.windowStart ?? -1) > loc.windowStart) return
    this.#values.set(loc.key, { count: value, ...(loc.windowStart === undefined ? {} : { windowStart: loc.windowStart }) })
    this.#dirty = true
    this.flush()
  }
  flush(): boolean {
    if (!this.#dirty) return true
    const ok = this.#store.write('counters', Object.fromEntries([...this.#values].map(([key, value]) => [key, value.windowStart === undefined ? value.count : value])))
    if (ok) this.#dirty = false
    return ok
  }
}

/** The slice of a domain table this store needs. */
export interface CounterTable {
  get: (key: string) => { count?: number; windowStart?: number } | undefined
  put: (key: string, value: { count: number; windowStart?: number }) => Promise<unknown>
}

/** The same store over the host's `channels` storage domain. */
export class DomainCounterStore implements CounterStore {
  readonly #table: CounterTable
  readonly #warn: (line: string) => void
  readonly #values = new Map<string, CounterRecord>()

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
    const loc = location(key)
    const cached = this.#values.get(loc.key)
    if (cached !== undefined) return countAt(cached, loc.windowStart)
    try {
      const record = this.#table.get(loc.key)
      if (record !== undefined) {
        const normalized = { count: typeof record.count === 'number' ? record.count : 0, ...(record.windowStart === undefined ? {} : { windowStart: record.windowStart }) }
        this.#values.set(loc.key, normalized)
        return countAt(normalized, loc.windowStart)
      }
      // Read old timestamp-keyed rows once, so upgrading never resets today's quota.
      const legacy = loc.key === key ? undefined : this.#table.get(key)
      const count = typeof legacy?.count === 'number' ? legacy.count : 0
      this.#values.set(loc.key, { count, ...(loc.windowStart === undefined ? {} : { windowStart: loc.windowStart }) })
      return count
    } catch (error) {
      this.#warn(`counter read failed for ${key}: ${String(error)}`)
      return 0
    }
  }

  readonly #writes = new Map<string, Promise<unknown>>()
  set(key: string, value: number): void {
    const loc = location(key)
    if (loc.windowStart !== undefined && (this.#values.get(loc.key)?.windowStart ?? -1) > loc.windowStart) return
    const record = { count: value, ...(loc.windowStart === undefined ? {} : { windowStart: loc.windowStart }) }
    this.#values.set(loc.key, record)
    const pending = (this.#writes.get(loc.key) ?? Promise.resolve())
      .then(() => this.#table.put(loc.key, record))
      .catch((error: unknown) => this.#warn(`counter write failed for ${key}: ${String(error)}`))
    this.#writes.set(loc.key, pending)
    void pending.then(() => { if (this.#writes.get(loc.key) === pending) this.#writes.delete(loc.key) })
  }
}
