/**
 * Replies committed before delivery, kept until each part is acknowledged.
 *
 * A channel that silently drops a reply is indistinguishable from an agent that
 * never answered, so a failed send is written here, retried with backoff, and
 * shown as backlog. Bounded: an outbox that grows without limit is a second bug.
 *
 * @module @derekluo/dsh-channels/store/outbox
 */
import { lineKey } from '../ids.js'
import { stateFile, type StateFile } from './state.js'
import { conforms, outboxInvariants, outboxSchema } from './schema.js'
import type { SendResult } from '../types.js'
import type { ArtifactDelivery } from '../artifacts.js'

export interface OutboxEntry {
  id: string
  taskId?: string
  target: { channel: string; accountId: string; conversationId: string }
  outgoing: { text?: string; artifact?: ArtifactDelivery; kind: 'reply' }
  /** Unsent parts of the same reply; older entries have no tail. */
  remaining?: string[]
  part?: number
  attempts: number
  nextAt: number
  lastCode?: string
  unconfirmed?: boolean
  attachments?: ArtifactDelivery[]
  includesArtifacts?: boolean
  filesFailed?: boolean
}

export interface OutboxFile {
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

type ProgressCommit = (file: OutboxFile, entry: OutboxEntry, result: { ok: boolean; unconfirmed?: boolean }, finished: boolean) => boolean

export class Outbox {
  readonly #store: StateFile
  readonly #max: number
  readonly #warn: (line: string) => void
  readonly #now: () => number
  readonly #commitProgress: ProgressCommit | undefined
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly #drainingChats = new Set<string>()

  constructor({ stateRoot, max = 50, warn = () => {}, now = Date.now, commitProgress }: { stateRoot: string; max?: number; warn?: (line: string) => void; now?: () => number; commitProgress?: ProgressCommit }) {
    this.#store = stateFile(stateRoot, warn)
    this.#max = max
    this.#warn = warn
    this.#now = now
    this.#commitProgress = commitProgress
  }

  #read(): OutboxEntry[] | undefined {
    let store: unknown
    try { store = this.#store.read<unknown>('outbox') }
    catch (error) {
      this.#warn(`outbox could not be read; refusing mutations: ${String(error)}`)
      return undefined
    }
    if (store === undefined) return []
    const items = store !== null && typeof store === 'object' && 'items' in store ? (store as { items?: unknown }).items : undefined
    if (store === null || typeof store !== 'object' || !('schemaVersion' in store) || (store as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray(items) || !conforms(outboxSchema, items) || !outboxInvariants(items)) {
      this.#warn('outbox has invalid contents; refusing mutations until repaired')
      return undefined
    }
    return items
  }

  #write(items: OutboxEntry[]): boolean {
    return this.#store.write('outbox', { schemaVersion: 1, items } satisfies OutboxFile)
  }

  /** Append a failed send. Refuse new entries once full, preserving replies already accepted. */
  add(target: OutboxEntry['target'], outgoing: OutboxEntry['outgoing'], result: { code?: string; retryAfterMs?: number; id?: string; remaining?: string[]; taskId?: string }): OutboxEntry | undefined {
    const text = outgoing.text ?? ''
    if (text.trim() === '' || outgoing.kind !== 'reply') return undefined
    const items = this.#read()
    if (items === undefined) return undefined
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
    return this.#read() ?? []
  }

  /** Commit the entire reply before any platform side effect. */
  enqueue(target: OutboxEntry['target'], parts: string[], taskId?: string, commit?: (file: OutboxFile) => boolean, attachments: ArtifactDelivery[] = []): OutboxEntry | undefined {
    parts = parts.filter((part) => part.trim() !== '')
    const items = this.#read()
    if ((!parts.length && !attachments.length) || (attachments.length > 0 && !taskId) || items === undefined || items.length >= this.#max) return undefined
    const entry: OutboxEntry = {
      id: `out-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target,
      outgoing: parts.length ? { kind: 'reply', text: parts[0]! } : { kind: 'reply', artifact: attachments[0]! },
      remaining: parts.slice(1),
      ...(attachments.length ? { includesArtifacts: true, attachments: parts.length ? attachments : attachments.slice(1) } : {}),
      ...(taskId === undefined ? {} : { taskId }), attempts: 0, nextAt: this.#now(),
    }
    items.push(entry)
    if (!conforms(outboxSchema, items) || !outboxInvariants(items)) return undefined
    return (commit ? commit({ schemaVersion: 1, items }) : this.#write(items)) ? entry : undefined
  }

  #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#tails.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    this.#tails.set(key, next)
    void next.finally(() => { if (this.#tails.get(key) === next) this.#tails.delete(key) }).catch(() => {})
    return next
  }

  /** Immediate sends and timer retries use the same per-chat writer. */
  sendPending(entry: OutboxEntry, send: (entry: OutboxEntry) => Promise<SendResult>): Promise<SendResult[]> {
    return this.#serial(lineKey(entry.target), async () => {
      const items = this.#read()
      if (items === undefined) return [{ ok: false, code: 'outbox-persist' }]
      const head = items.find((item) => lineKey(item.target) === lineKey(entry.target))
      if (head === undefined) return [{ ok: true, unconfirmed: true }]
      if (head.id !== entry.id || head.nextAt > this.#now()) return [{ ok: false, code: 'queued' }]
      const result = await this.#consume(head, send)
      return result.persisted ? result.results : [...result.results, { ok: false, code: 'outbox-persist' }]
    })
  }

  drop(id: string): boolean {
    const items = this.#read()
    if (items === undefined) return false
    const kept = items.filter((entry) => entry.id !== id)
    if (kept.length === items.length) return false
    return this.#write(kept)
  }

  /** Retry every entry whose backoff elapsed. Returns how many were delivered. */
  async drain(send: (entry: OutboxEntry) => Promise<{ ok: boolean; code?: string; retryAfterMs?: number }>): Promise<number> {
    const keys = new Set((this.#read() ?? []).map((entry) => lineKey(entry.target)))
    const available = [...keys].filter((key) => !this.#drainingChats.has(key))
    // Claim the whole pass before invoking callbacks, including reentrant drains.
    for (const key of available) this.#drainingChats.add(key)
    const counts = await Promise.all(available.map((key) => this.#serial(key, async () => {
      try {
        let delivered = 0
        for (const candidate of this.#read() ?? []) {
          if (lineKey(candidate.target) !== key) continue
          const current = this.#read()?.find((entry) => entry.id === candidate.id)
          if (current === undefined) continue
          if (current.nextAt > this.#now()) break
          const result = await this.#consume(current, async (entry) => {
            try { return await send(entry) }
            catch (error) { this.#warn(`outbox retry failed: ${String(error)}`); return { ok: false, code: 'retry-threw' } }
          }, true)
          if (!result.persisted || result.results.some((attempt) => !attempt.ok)) break
          delivered++
        }
        return delivered
      } finally { this.#drainingChats.delete(key) }
    })))
    return counts.reduce((sum, count) => sum + count, 0)
  }

  async #consume<T extends { ok: boolean; code?: string; retryAfterMs?: number; unconfirmed?: boolean }>(current: OutboxEntry, send: (entry: OutboxEntry) => Promise<T>, retry = false): Promise<{ results: T[]; persisted: boolean }> {
    const results: T[] = []
    for (;;) {
      const result = await send(current)
      results.push(result)
      const items = this.#read()
      if (items === undefined) return { results, persisted: false }
      const index = items.findIndex((entry) => entry.id === current.id)
      // A cancelled schedule can remove its entry inside send().
      if (index === -1) return { results, persisted: true }
      const entry = items[index]!
      if (result.ok && result.unconfirmed) entry.unconfirmed = true
      const unavailable = !result.ok && result.code === 'artifact-unavailable' && entry.outgoing.artifact !== undefined
      if (unavailable) entry.filesFailed = true
      const advance = result.ok || unavailable
      const text = advance ? entry.remaining?.[0] : undefined
      const nextArtifact = advance && text === undefined ? entry.attachments?.[0] : undefined
      const next = text !== undefined || nextArtifact !== undefined
      if (advance && next) {
        entry.outgoing = text !== undefined ? { kind: 'reply', text } : { kind: 'reply', artifact: nextArtifact! }
        if (text !== undefined) entry.remaining = entry.remaining!.slice(1)
        else entry.attachments = entry.attachments!.slice(1)
        entry.part = (entry.part ?? 0) + 1
        entry.attempts = 0
      } else if (advance) items.splice(index, 1)
      else {
        if (retry) entry.attempts += 1
        entry.nextAt = this.#now() + retryDelay(entry.attempts + 1, result.retryAfterMs)
        if (result.code !== undefined) entry.lastCode = result.code
      }
      const file: OutboxFile = { schemaVersion: 1, items }
      if (!(this.#commitProgress ? this.#commitProgress(file, entry, result, advance && !next) : this.#write(items))) return { results, persisted: false }
      if (!advance || !next) return { results, persisted: true }
      current = this.#read()?.find((item) => item.id === current.id)!
      if (current === undefined) return { results, persisted: true }
    }
  }
}

function retryDelay(attempts: number, platformWait?: number): number {
  return Math.max(backoffMs(attempts), typeof platformWait === 'number' && Number.isFinite(platformWait) ? Math.max(0, platformWait) : 0)
}
