/**
 * Text that could not be delivered, kept until it can be retried.
 *
 * A channel that silently drops a reply is indistinguishable from an agent that
 * never answered, so a failed send is written here, retried with backoff, and
 * shown as backlog. Bounded: an outbox that grows without limit is a second bug.
 *
 * @module @derekluo/dsh-channels/store/outbox
 */
import { statePath } from './layout.js'
import { lineKey } from '../ids.js'

import { atomicWriteJson, readJsonFile } from './atomic.js'

export interface OutboxEntry {
  id: string
  taskId?: string
  target: { channel: string; accountId: string; conversationId: string }
  outgoing: { text?: string; kind: 'reply' | 'notice' | 'question' }
  /** Unsent parts of the same reply; older entries have no tail. */
  remaining?: string[]
  part?: number
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
    this.#file = statePath(stateRoot, 'outbox')
    this.#max = max
    this.#warn = warn
    this.#now = now
  }

  #read(): OutboxEntry[] {
    const store = readJsonFile<unknown>(this.#file, () => ({ schemaVersion: 1, items: [] }), this.#warn)
    const items = store !== null && typeof store === 'object' && 'items' in store ? store.items : undefined
    if (!Array.isArray(items)) { this.#warn('outbox has invalid contents'); return [] }
    const valid = items.filter(validEntry)
    if (valid.length !== items.length) this.#warn('outbox contains invalid entries; repair the state file')
    return valid
  }

  #write(items: OutboxEntry[]): boolean {
    return atomicWriteJson(this.#file, { schemaVersion: 1, items } satisfies OutboxFile, { warn: this.#warn })
  }

  /** Append a failed send. Refuse new entries once full, preserving replies already accepted. */
  add(target: OutboxEntry['target'], outgoing: OutboxEntry['outgoing'], result: { code?: string; retryAfterMs?: number; id?: string; remaining?: string[]; taskId?: string }): OutboxEntry | undefined {
    const text = outgoing.text ?? ''
    if (text.trim() === '' || outgoing.kind !== 'reply') return undefined
    const items = this.#read()
    if (items.length >= this.#max) { this.#warn('outbox is full; reply could not be saved'); return undefined }
    const entry: OutboxEntry = {
      id: result.id ?? `out-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target,
      outgoing,
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      ...(result.remaining === undefined || result.remaining.length === 0 ? {} : { remaining: result.remaining }),
      attempts: 0,
      nextAt: this.#now() + retryDelay(1, result.retryAfterMs),
      ...(result.code === undefined ? {} : { lastCode: result.code }),
    }
    items.push(entry)
    return this.#write(items) ? entry : undefined
  }

  list(): OutboxEntry[] {
    return this.#read()
  }

  drop(id: string): boolean {
    const items = this.#read()
    const kept = items.filter((entry) => entry.id !== id)
    if (kept.length === items.length) return false
    return this.#write(kept)
  }

  /** Retry every entry whose backoff elapsed. Returns how many were delivered. */
  async drain(send: (entry: OutboxEntry) => Promise<{ ok: boolean; code?: string; retryAfterMs?: number }>): Promise<number> {
    if (this.#draining) return 0
    this.#draining = true
    try {
      let delivered = 0
      const blocked = new Set<string>()
      for (const candidate of this.#read()) {
        const key = lineKey(candidate.target)
        if (blocked.has(key)) continue
        let current = this.#read().find((entry) => entry.id === candidate.id)
        if (current === undefined) continue
        if (current.nextAt > this.#now()) { blocked.add(key); continue }
        while (current !== undefined) {
          let result: { ok: boolean; code?: string; retryAfterMs?: number }
          try { result = await send(current) }
          catch (error) {
            this.#warn(`outbox retry failed: ${String(error)}`)
            result = { ok: false, code: 'retry-threw' }
          }
          const items = this.#read()
          const index = items.findIndex((entry) => entry.id === candidate.id)
          if (index === -1) break
          const entry = items[index]!
          const next = result.ok ? entry.remaining?.[0] : undefined
          if (result.ok && next !== undefined) {
            entry.outgoing = { ...entry.outgoing, text: next }
            entry.remaining = entry.remaining!.slice(1)
            entry.part = (entry.part ?? 0) + 1
            entry.attempts = 0
          } else if (result.ok) {
            items.splice(index, 1)
          } else {
            entry.attempts += 1
            entry.nextAt = this.#now() + retryDelay(entry.attempts + 1, result.retryAfterMs)
            if (result.code !== undefined) entry.lastCode = result.code
            blocked.add(key)
          }
          // Commit each successful part before attempting another one.
          if (!this.#write(items)) { blocked.add(key); break }
          if (!result.ok) break
          if (next === undefined) { delivered++; break }
          current = this.#read().find((item) => item.id === candidate.id)
        }
      }
      return delivered
    } finally {
      this.#draining = false
    }
  }
}

function validEntry(value: unknown): value is OutboxEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<OutboxEntry>
  return typeof entry.id === 'string' && (entry.taskId === undefined || typeof entry.taskId === 'string') && entry.target !== null && typeof entry.target === 'object'
    && ['channel', 'accountId', 'conversationId'].every((key) => typeof entry.target![key as keyof OutboxEntry['target']] === 'string')
    && entry.outgoing?.kind === 'reply' && typeof entry.outgoing.text === 'string'
    && typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) && entry.attempts >= 0
    && Number.isFinite(entry.nextAt)
    && (entry.part === undefined || (Number.isSafeInteger(entry.part) && entry.part >= 0))
    && (entry.remaining === undefined || (Array.isArray(entry.remaining) && entry.remaining.every((part) => typeof part === 'string')))
}

function retryDelay(attempts: number, platformWait?: number): number {
  return Math.max(backoffMs(attempts), typeof platformWait === 'number' && Number.isFinite(platformWait) ? Math.max(0, platformWait) : 0)
}
