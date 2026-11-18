/** Telegram acknowledgement and handoff: controls may overtake; ordinary chat inputs may not. */
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeInbound, type NormalizedInbound } from './normalize.js'
import type { TelegramTransport, TransportLogger } from './transport.js'

interface PendingUpdate { done: boolean; settled: Promise<void> }

export async function runTelegramPolling({ transport, accountId, priority, deliver, logger }: {
  transport: TelegramTransport
  accountId: string
  priority: (message: NormalizedInbound) => boolean
  deliver: (message: NormalizedInbound) => Promise<void>
  logger: TransportLogger
}): Promise<void> {
  const signal = transport.signal
  const pending = new Map<number, PendingUpdate>()
  const tails = new Map<string, Promise<void>>()
  const active = new Set<Promise<void>>()
  let offset = 0
  const pause = (ms: number) => delay(ms, undefined, { signal }).catch(() => {})

  const deliverWithRetry = async (message: NormalizedInbound, limited: boolean): Promise<void> => {
    while (!signal.aborted) {
      try {
        while (limited && active.size >= 2 && !signal.aborted) await Promise.race(active).catch(() => {})
        if (signal.aborted) return
        const work = deliver(message)
        if (limited) active.add(work)
        try { await work } finally { active.delete(work) }
        return
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'DSH_INBOUND_RETRY') throw error
        logger.warn(`telegram durable handoff will retry: ${String(error)}`)
        await pause(3000)
      }
    }
  }

  const schedule = (message: NormalizedInbound): Promise<void> => {
    if (!(message.mediaItems?.length) && priority(message)) return deliverWithRetry(message, false)
    const key = message.conversationId
    // Keep the chat's position through retry backoff without occupying a global slot.
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => deliverWithRetry(message, true))
    tails.set(key, next)
    void next.finally(() => { if (tails.get(key) === next) tails.delete(key) }).catch(() => {})
    return next
  }

  const acknowledgeCompletedPrefix = (): void => {
    for (const [id, entry] of [...pending].sort(([left], [right]) => left - right)) {
      if (!entry.done) { offset = Math.max(offset, id); break }
      pending.delete(id)
      offset = id + 1
    }
  }

  const accept = (id: number, message: NormalizedInbound | null): void => {
    if (pending.has(id)) return
    const entry: PendingUpdate = { done: false, settled: Promise.resolve() }
    pending.set(id, entry)
    entry.settled = (message === null ? Promise.resolve() : schedule(message))
      .catch((error: unknown) => logger.warn(`telegram update failed: ${String((error as Error)?.message ?? error)}`))
      .then(() => { entry.done = true })
  }

  const waitForProgress = async (): Promise<void> => {
    const waiting = [...pending.values()].filter((entry) => !entry.done)
    if (waiting.length === 0) return
    // An unacknowledged update makes getUpdates return immediately. Pace replays, not completed work.
    const wake = new AbortController()
    try {
      await Promise.race([
        delay(1000, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch(() => {}),
        ...waiting.map((entry) => entry.settled),
      ])
    } finally { wake.abort() }
  }

  try {
    while (!signal.aborted) {
      acknowledgeCompletedPrefix()
      try {
        const updates = await transport.pollOnce(offset)
        for (const update of updates.sort((left, right) => (left.update_id ?? 0) - (right.update_id ?? 0))) {
          if (signal.aborted) break
          const id = update.update_id
          if (id === undefined || !Number.isSafeInteger(id) || id < offset || pending.has(id)) continue
          if (pending.size >= 100) break
          accept(id, normalizeInbound(update, accountId))
        }
      } catch (error) {
        if (signal.aborted) break
        logger.warn(`telegram poll failed: ${String((error as Error)?.message ?? error)}`)
        await pause(3000)
        continue
      }
      await waitForProgress()
    }
  } finally { await Promise.allSettled([...pending.values()].map((entry) => entry.settled)) }
}
