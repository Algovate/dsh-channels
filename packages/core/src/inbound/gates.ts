/**
 * The gate chain: may this message reach the agent?
 *
 * Pure functions over a small context, in a fixed order, each returning a
 * reason code so the card and `/diag` can explain a refusal instead of leaving
 * the user with silence. Deny-by-default is the whole security model here:
 * an empty allowlist means nobody.
 *
 * @module @rodin/dsh-channels/inbound/gates
 */
import type { InboundMessage } from '../types.js'

export type GateReason =
  | 'not-logged-in'
  | 'not-allowed'
  | 'chat-not-allowed'
  | 'rate-minute'
  | 'rate-day'

export interface RateLimiter {
  /** Consume one slot; false when the window is exhausted. */
  take(key: string): boolean
}

export interface GateContext {
  /** Per-account credential state, from the adapter. */
  expiredAccounts: Set<string>
  /** Sender ids allowed for one account; empty denies everyone. */
  allowlistFor(accountId: string): string[]
  /** Optional conversation allowlist; empty allows any conversation of an allowed sender. */
  allowedChats: string[]
  minute: RateLimiter
  day: RateLimiter
  keyOf(message: InboundMessage): string
}

export type GateDecision = { allow: true } | { allow: false; reason: GateReason; detail?: string }

export function gateMessage(message: InboundMessage, context: GateContext): GateDecision {
  if (context.expiredAccounts.has(message.accountId)) return { allow: false, reason: 'not-logged-in' }

  const allowed = context.allowlistFor(message.accountId)
  if (!allowed.includes(message.senderId)) {
    return { allow: false, reason: 'not-allowed', detail: `${allowed.length} allowed sender(s)` }
  }

  if (context.allowedChats.length > 0 && !context.allowedChats.includes(message.conversationId)) {
    return { allow: false, reason: 'chat-not-allowed' }
  }

  const key = context.keyOf(message)
  if (!context.minute.take(key)) return { allow: false, reason: 'rate-minute' }
  if (!context.day.take(key)) return { allow: false, reason: 'rate-day' }
  return { allow: true }
}

/** Fixed-window limiter. `limit <= 0` means unlimited. */
export function createRateLimiter({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const buckets = new Map<string, { startedAt: number; used: number }>()
  return {
    take(key: string): boolean {
      if (!Number.isFinite(limit) || limit <= 0) return true
      const at = now()
      const bucket = buckets.get(key)
      if (bucket === undefined || at - bucket.startedAt >= windowMs) {
        buckets.set(key, { startedAt: at, used: 1 })
        return true
      }
      if (bucket.used >= limit) return false
      bucket.used += 1
      return true
    },
  }
}

/**
 * A fixed-window limiter whose counts survive a restart.
 *
 * The window key is the window's start instant, so yesterday's count can never
 * be read as today's: a new window means a new key and the old row is simply
 * never read again (the file keeps a handful of keys).
 */
export function createDurableRateLimiter({
  limit,
  windowMs,
  prefix,
  store,
  now = Date.now,
}: {
  limit: number
  windowMs: number
  prefix: string
  store: { get(key: string): number; set(key: string, value: number): void }
  now?: () => number
}): RateLimiter {
  return {
    take(key: string): boolean {
      if (!Number.isFinite(limit) || limit <= 0) return true
      const at = now()
      const windowStart = Math.floor(at / windowMs) * windowMs
      const windowKey = `${prefix}:${key}:${windowStart}`
      const used = store.get(windowKey)
      if (used >= limit) return false
      store.set(windowKey, used + 1)
      return true
    },
  }
}
