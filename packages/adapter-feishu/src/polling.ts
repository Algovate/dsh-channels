/**
 * Handoff and ordering for pushed Feishu events.
 *
 * The persistent connection pushes events instead of answering a poll, so there
 * is no offset to confirm: the gateway frame is acknowledged only after the
 * core's durable `offer()` resolves (see socket.ts). What still has to be
 * ordered is *within* the client: ordinary messages from one chat must stay
 * serial, and a `DSH_INBOUND_RETRY` from the durable handoff occupies that
 * chat's position until it succeeds, exactly like the Telegram poller.
 * Priority text — controls and interaction answers — may overtake media work.
 *
 * @module @derekluo/dsh-channels-feishu/polling
 */
import { setTimeout as delay } from 'node:timers/promises'

import type { FeishuEnvelope, NormalizedInbound } from './normalize.js'
import type { TransportLogger } from './transport.js'

export interface FeishuDispatcher {
  /** Called for every reassembled event; resolves after the durable handoff. */
  onEvent(envelope: FeishuEnvelope): Promise<void>
}

interface DeliveryHooks {
  accountId: string
  priority: (message: NormalizedInbound) => boolean
  /** Normalize then enrich and offer; throws DSH_INBOUND_RETRY to retain the event. */
  deliver: (message: NormalizedInbound) => Promise<void>
  normalize: (envelope: FeishuEnvelope, accountId: string) => NormalizedInbound | null
  logger: TransportLogger
}

const MAX_CONCURRENT_LIMITED = 2

/**
 * Wire the socket's event callback to normalized, ordered, retried delivery.
 * Events that do not describe a person's input resolve immediately so their
 * frame is acknowledged without work.
 */
export function createDispatcher({ accountId, priority, deliver, normalize, logger }: DeliveryHooks): FeishuDispatcher {
  const signal = new AbortController()
  const tails = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()

  const deliverWithRetry = async (message: NormalizedInbound, limited: boolean): Promise<void> => {
    while (!signal.signal.aborted) {
      try {
        while (limited && active.size >= MAX_CONCURRENT_LIMITED && !signal.signal.aborted) {
          await Promise.race(active).catch(() => {})
        }
        if (signal.signal.aborted) return
        const work = deliver(message)
        if (limited) active.add(work)
        try { await work } finally { active.delete(work) }
        return
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'DSH_INBOUND_RETRY') throw error
        logger.warn(`feishu durable handoff will retry: ${String(error)}`)
        await delay(3000, undefined, { signal: signal.signal }).catch(() => {})
      }
    }
  }

  const schedule = (message: NormalizedInbound): Promise<void> => {
    if (!(message.mediaItems?.length) && priority(message)) return deliverWithRetry(message, false)
    const key = message.conversationId
    // Hold the chat's position through backoff without taking a global slot.
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => deliverWithRetry(message, true))
    tails.set(key, next)
    void next.finally(() => { if (tails.get(key) === next) tails.delete(key) }).catch(() => {})
    return next
  }

  return {
    async onEvent(envelope) {
      const message = normalize(envelope, accountId)
      if (message === null) return
      await schedule(message)
    },
  }
}
