/**
 * Two-phase outbound journal.
 *
 * "The log says out, the phone has nothing" was unanswerable in the reference
 * implementation because the line was written before the send. Here every
 * outbound message is written twice: `sending` before the adapter is called and
 * `settled` after, with the delivery state the adapter reported. A reader joins
 * the two by `id`; an orphan `sending` line is exactly the evidence that a send
 * never finished.
 *
 * Append-only JSONL, one file per local day, same shape as the rest of the
 * plugin's day buckets. Failures to write only warn: the journal is diagnostics,
 * never the reason a message is lost.
 *
 * @module @derekluo/dsh-channels/store/journal
 */
import fs from 'node:fs'
import path from 'node:path'
import { sameTarget } from '../ids.js'
import type { Target } from '../types.js'

export interface JournalLine {
  at: number
  direction: 'in' | 'out'
  phase: 'sending' | 'settled' | 'received' | 'refused'
  id: string
  channel: string
  accountId: string
  conversationId: string
  kind?: string
  text?: string
  media?: string[]
  delivery?: 'accepted' | 'unconfirmed' | 'failed'
  messageId?: string
  code?: string
  reason?: string
}

function dayStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function receiptKey(target: Target, messageId: string): string {
  return JSON.stringify([target.channel, target.accountId, target.conversationId, messageId])
}

export class Journal {
  readonly #root: string
  readonly #warn: (line: string) => void
  readonly #now: () => number
  readonly #receipts = new Map<string, Set<string>>()

  constructor({ stateRoot, warn = () => {}, now = Date.now }: { stateRoot: string; warn?: (line: string) => void; now?: () => number }) {
    this.#root = path.join(stateRoot, 'journal')
    this.#warn = warn
    this.#now = now
  }

  file(at = this.#now()): string {
    return path.join(this.#root, `journal-${dayStamp(at)}.jsonl`)
  }

  append(line: Omit<JournalLine, 'at'> & { at?: number }): boolean {
    const at = line.at ?? this.#now()
    if (line.direction === 'in' && line.phase === 'received' && line.messageId !== undefined) {
      this.#receivedOn(at).add(receiptKey(line, line.messageId))
    }
    try {
      fs.mkdirSync(this.#root, { recursive: true })
      fs.appendFileSync(this.file(at), `${JSON.stringify({ ...line, at })}\n`, { mode: 0o600 })
      return true
    } catch (error) {
      this.#warn(`journal write failed: ${String((error as Error)?.message ?? error)}`)
      return false
    }
  }

  /** Recently accepted provider deliveries, including a batch replayed after restart. */
  received(target: Target, messageId: string | undefined): boolean {
    if (messageId === undefined) return false
    const day = new Date(this.#now())
    const key = receiptKey(target, messageId)
    const days = new Set<string>()
    let found = false
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      const at = day.getTime()
      days.add(dayStamp(at))
      if (this.#receivedOn(at).has(key)) found = true
      day.setDate(day.getDate() - 1)
    }
    for (const cached of this.#receipts.keys()) {
      if (!days.has(cached)) this.#receipts.delete(cached)
    }
    return found
  }

  #receivedOn(at: number): Set<string> {
    const day = dayStamp(at)
    const cached = this.#receipts.get(day)
    if (cached !== undefined) return cached
    const receipts = new Set<string>()
    for (const line of this.read(at)) {
      if (line?.direction === 'in' && line.phase === 'received' && typeof line.messageId === 'string') {
        receipts.add(receiptKey(line, line.messageId))
      }
    }
    this.#receipts.set(day, receipts)
    return receipts
  }

  /** Every line of one day, oldest first. A malformed line is skipped, not fatal. */
  read(at = this.#now()): JournalLine[] {
    let text: string
    try {
      text = fs.readFileSync(this.file(at), 'utf8')
    } catch {
      return []
    }
    const out: JournalLine[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as JournalLine)
      } catch {
        // A half-written line from a killed process is not a reason to lose the day.
      }
    }
    return out
  }

  /**
   * Join `sending` and `settled` lines by id. A `sending` with no settlement is
   * reported as `pending` — the only honest answer for a send that never
   * finished.
   */
  outbound(at = this.#now(), target?: Target): Array<{ id: string; text: string; state: 'accepted' | 'unconfirmed' | 'failed' | 'pending'; code?: string }> {
    const byId = new Map<string, { id: string; text: string; state: 'accepted' | 'unconfirmed' | 'failed' | 'pending'; code?: string }>()
    for (const line of this.read(at)) {
      if (line.direction !== 'out') continue
      if (target !== undefined && !sameTarget(line, target)) continue
      if (line.phase === 'sending') {
        byId.delete(line.id)
        byId.set(line.id, { id: line.id, text: line.text ?? '', state: 'pending' })
        continue
      }
      if (line.phase !== 'settled') continue
      byId.set(line.id, {
        id: line.id,
        text: line.text ?? byId.get(line.id)?.text ?? '',
        state: line.delivery ?? 'pending',
        ...(line.code === undefined ? {} : { code: line.code }),
      })
    }
    return [...byId.values()]
  }
}
