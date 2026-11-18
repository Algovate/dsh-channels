/** Pending senders: deny by default, but let the operator approve in the card instead of reading logs. */
import { randomUUID } from 'node:crypto'
import type { InboundMessage } from '../types.js'
import { stateFile, type StateFile } from './state.js'

const MAX_PAIRINGS = 20
const PAIRING_TTL_MS = 24 * 60 * 60_000
const NOTICE_GAP_MS = 10 * 60_000

export interface PairingRequest {
  id: string
  channel: string
  accountId: string
  conversationId: string
  senderId: string
  text: string
  at: number
  lastNoticeAt: number
  attempts: number
}

export class Pairings {
  readonly #store: StateFile
  readonly #warn: (line: string) => void
  #items: PairingRequest[] = []
  #unreadable = false

  constructor(root: string, warn: (line: string) => void) {
    this.#store = stateFile(root, warn)
    this.#warn = warn
    try {
      const saved: unknown = this.#store.read<unknown>('pairings')
      if (saved === undefined) return
      if (!Array.isArray(saved) || !saved.every(validPairing)) throw new Error('invalid pairing records')
      this.#items = saved
    } catch (error) {
      this.#unreadable = true
      warn(`pending pairing requests could not be loaded: ${String(error)}`)
    }
  }

  list(now = Date.now()): readonly PairingRequest[] {
    this.#prune(now)
    return this.#items
  }

  get(id: string): PairingRequest | undefined {
    this.#prune()
    return this.#items.find((item) => item.id === id)
  }

  /** Record one refused sender; returns whether the sender should be told again. */
  request(message: InboundMessage, now = Date.now()): { request?: PairingRequest; notice: boolean } {
    if (this.#unreadable) return { notice: false }
    this.#prune(now)
    const existing = this.#items.find((item) => item.channel === message.channel && item.accountId === message.accountId && item.senderId === message.senderId)
    if (existing !== undefined) {
      existing.attempts += 1
      existing.text = preview(message.text)
      const notice = now - existing.lastNoticeAt >= NOTICE_GAP_MS
      if (notice) existing.lastNoticeAt = now
      this.#write()
      return { request: existing, notice }
    }
    if (this.#items.length >= MAX_PAIRINGS) return { notice: false }
    const request: PairingRequest = {
      id: randomUUID(),
      channel: message.channel,
      accountId: message.accountId,
      conversationId: message.conversationId,
      senderId: message.senderId,
      text: preview(message.text),
      at: now,
      lastNoticeAt: now,
      attempts: 1,
    }
    this.#items.push(request)
    this.#write()
    return { request, notice: true }
  }

  remove(id: string): boolean {
    if (this.#unreadable) return false
    const kept = this.#items.filter((item) => item.id !== id)
    if (kept.length === this.#items.length) return false
    this.#items = kept
    return this.#write()
  }

  #prune(now = Date.now()): void {
    const kept = this.#items.filter((item) => now - item.at < PAIRING_TTL_MS)
    if (kept.length === this.#items.length) return
    this.#items = kept
    this.#write()
  }

  #write(): boolean {
    if (this.#unreadable) return false
    return this.#store.write('pairings', this.#items)
  }
}

function preview(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function validPairing(value: unknown): value is PairingRequest {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<PairingRequest>
  return typeof item.id === 'string' && typeof item.channel === 'string' && typeof item.accountId === 'string'
    && typeof item.conversationId === 'string' && typeof item.senderId === 'string' && typeof item.text === 'string'
    && Number.isFinite(item.at) && Number.isFinite(item.lastNoticeAt)
    && Number.isSafeInteger(item.attempts) && (item.attempts ?? 0) > 0
}
