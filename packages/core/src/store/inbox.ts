/** Only work that has not started is replayable: tools may already have effects once a turn starts. */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { InboundMessage } from '../types.js'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'
import { receiptKey } from './journal.js'

const RECEIPT_WINDOW_MS = 3 * 24 * 60 * 60_000
export interface InboxEntry { id: string; message: InboundMessage; sessionId: string; workingDirectory?: string; project?: string; clearedAt?: number }

export class Inbox {
  readonly #file: string
  readonly #warn: (line: string) => void
  #items: InboxEntry[] = []
  #unreadable = false

  constructor(root: string, warn: (line: string) => void) {
    this.#file = statePath(root, 'inbox')
    this.#warn = warn
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
      if (!Array.isArray(saved) || !saved.every(validEntry)) throw new Error('invalid inbox records')
      this.#items = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#unreadable = true
        warn(`inbox could not be loaded; refusing new turns until repaired: ${String(error)}`)
      }
    }
  }

  list(): readonly InboxEntry[] { return this.#items.filter((entry) => entry.clearedAt === undefined) }

  contains(message: InboundMessage): boolean {
    return message.platformMessageId !== undefined && this.#items.some((entry) =>
      (entry.clearedAt === undefined || entry.clearedAt > Date.now() - RECEIPT_WINDOW_MS) && entry.message.platformMessageId !== undefined && receiptKey(entry.message, entry.message.platformMessageId) === receiptKey(message, message.platformMessageId!))
  }

  add(message: InboundMessage, sessionId: string, workingDirectory?: string, project?: string): InboxEntry {
    if (this.list().length >= 500) throw retryError('inbox is full; provider delivery must be retried')
    // Snapshot adapter-owned context as well as paths; adapters restore only their own context.
    const entry: InboxEntry = JSON.parse(JSON.stringify({ id: randomUUID(), message, sessionId, workingDirectory, project }))
    this.#write([...this.#items, entry])
    return entry
  }

  remove(id: string): void { this.#write(this.#items.filter((entry) => entry.id !== id)) }

  /** Commit removal and redelivery receipts together; the diagnostic journal may be unavailable. */
  clear(ids: ReadonlySet<string>): void {
    this.#write(this.#items.map((entry) => ids.has(entry.id) ? { ...entry, clearedAt: Date.now() } : entry))
  }

  #write(items: InboxEntry[]): void {
    items = items.filter((entry) => entry.clearedAt === undefined || entry.clearedAt > Date.now() - RECEIPT_WINDOW_MS)
    if (this.#unreadable || !atomicWriteJson(this.#file, items, { warn: this.#warn })) throw retryError('inbound message could not be persisted; provider delivery must be retried')
    this.#items = items
  }
}

function validEntry(value: unknown): value is InboxEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<InboxEntry>
  const message = entry.message
  return (entry.project === undefined || typeof entry.project === 'string') && (entry.workingDirectory === undefined || typeof entry.workingDirectory === 'string') && (entry.clearedAt === undefined || Number.isFinite(entry.clearedAt)) && typeof entry.id === 'string' && typeof entry.sessionId === 'string' && message !== null && typeof message === 'object'
    && ['channel', 'accountId', 'conversationId', 'senderId', 'text'].every((key) => typeof message[key as keyof InboundMessage] === 'string')
    && (message.attachmentErrors === undefined || (Array.isArray(message.attachmentErrors) && message.attachmentErrors.every((error) => typeof error === 'string')))
    && typeof message.group === 'boolean' && Number.isFinite(message.at) && Array.isArray(message.media)
    && message.media.every((media) => media !== null && typeof media === 'object' && ['image', 'file', 'voice', 'video'].includes(media.kind)
      && typeof media.path === 'string' && typeof media.mime === 'string' && Number.isFinite(media.bytes))
}

function retryError(message: string): Error {
  return Object.assign(new Error(message), { code: 'DSH_INBOUND_RETRY' })
}
