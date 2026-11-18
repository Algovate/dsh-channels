/**
 * The gate chain: may this message reach the agent?
 *
 * Pure functions over a small context, in a fixed order, each returning a
 * reason code so the card and `/diag` can explain a refusal instead of leaving
 * the user with silence. Deny-by-default is the whole security model here:
 * an empty allowlist means nobody.
 *
 * @module @derekluo/dsh-channels/inbound/gates
 */
import type { InboundMessage } from '../types.js'

export type GateReason =
  | 'not-logged-in'
  | 'duplicate'
  | 'not-allowed'
  | 'chat-not-allowed'
  | 'not-addressed'
  | 'rate-minute'
  | 'rate-day'

export interface RateLimiter {
  /** Consume one slot; false when the window is exhausted. */
  take(key: string): boolean
  /** Hold a slot in memory until delivery commits it or cancellation releases it. */
  reserve(key: string): Reservation | undefined
}

export type Reservation = (commit: boolean) => void

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

export function authorizeMessage(message: InboundMessage, context: GateContext): GateDecision {
  if (context.expiredAccounts.has(message.accountId)) return { allow: false, reason: 'not-logged-in' }

  const allowed = context.allowlistFor(message.accountId)
  if (!allowed.includes(message.senderId)) {
    return { allow: false, reason: 'not-allowed', detail: `${allowed.length} allowed sender(s)` }
  }

  if (context.allowedChats.length > 0 && !context.allowedChats.includes(message.conversationId)) {
    return { allow: false, reason: 'chat-not-allowed' }
  }

  return { allow: true }
}

export function chargeMessage(message: InboundMessage, context: GateContext): GateDecision {
  const admission = reserveMessage(message, context)
  if (!admission.allow) return admission
  admission.finish(true)
  return { allow: true }
}

export function reserveMessage(message: InboundMessage, context: GateContext):
  | { allow: true; finish: Reservation }
  | Exclude<GateDecision, { allow: true }> {
  const key = context.keyOf(message)
  const minute = context.minute.reserve(key)
  if (minute === undefined) return { allow: false, reason: 'rate-minute' }
  const day = context.day.reserve(key)
  if (day === undefined) {
    minute(false)
    return { allow: false, reason: 'rate-day' }
  }
  return { allow: true, finish: (commit) => { minute(commit); day(commit) } }
}

export function gateMessage(message: InboundMessage, context: GateContext): GateDecision {
  const result = authorizeMessage(message, context)
  return result.allow ? chargeMessage(message, context) : result
}

/** A limit is a number or a reader, so a settings change applies without a rebuild. */
export type LimitSource = number | (() => number)

function resolveLimit(limit: LimitSource): number {
  return typeof limit === 'function' ? limit() : limit
}

function withReservation(reserve: RateLimiter['reserve']): RateLimiter {
  return {
    reserve,
    take(key) {
      const finish = reserve(key)
      if (finish === undefined) return false
      finish(true)
      return true
    },
  }
}

/** Fixed-window limiter. `limit <= 0` means unlimited. */
export function createRateLimiter({ limit, windowMs, now = Date.now }: { limit: LimitSource; windowMs: number; now?: () => number }): RateLimiter {
  const buckets = new Map<string, { startedAt: number; used: number }>()
  return withReservation((key) => {
    const current = resolveLimit(limit)
    if (!Number.isFinite(current) || current <= 0) return () => {}
    const at = now()
    let bucket = buckets.get(key)
    if (bucket === undefined || at - bucket.startedAt >= windowMs) {
      bucket = { startedAt: at, used: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.used >= current) return undefined
    bucket.used += 1
    const reserved = bucket
    let finished = false
    return (commit) => {
      if (finished) return
      finished = true
      if (!commit) reserved.used -= 1
    }
  })
}

/**
 * A fixed-window limiter whose counts survive a restart.
 *
 * The limiter addresses each reservation by its window start. Durable stores
 * compact those addresses into one timestamped row per subject and limit type.
 */
export function createDurableRateLimiter({
  limit,
  windowMs,
  prefix,
  store,
  now = Date.now,
}: {
  limit: LimitSource
  windowMs: number
  prefix: string
  store: { get(key: string): number; set(key: string, value: number): void }
  now?: () => number
}): RateLimiter {
  const held = new Map<string, number>()
  return withReservation((key) => {
    const current = resolveLimit(limit)
    if (!Number.isFinite(current) || current <= 0) return () => {}
    const windowStart = Math.floor(now() / windowMs) * windowMs
    const windowKey = `${prefix}:${key}:${windowStart}`
    const pending = held.get(windowKey) ?? 0
    if (store.get(windowKey) + pending >= current) return undefined
    held.set(windowKey, pending + 1)
    let finished = false
    return (commit) => {
      if (finished) return
      finished = true
      const remaining = (held.get(windowKey) ?? 1) - 1
      if (remaining === 0) held.delete(windowKey)
      else held.set(windowKey, remaining)
      if (commit) store.set(windowKey, store.get(windowKey) + 1)
    }
  })
}
