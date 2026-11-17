/**
 * Session identity, derived and stable.
 *
 * A conversation maps to exactly one session id so a restart resumes the line
 * instead of opening a new one. The hash covers channel + account +
 * conversation, so two accounts that happen to share a peer id stay apart.
 *
 * @module @rodin/dsh-channels/ids
 */
import { createHash } from 'node:crypto'

import type { ChannelId, Target } from './types.js'

/** Identity of one conversation line, as used by queues and stores. */
export function lineKey(target: Target): string {
  return `${target.channel}|${target.accountId}|${target.conversationId}`
}

/** Compare addresses without relying on their serialized form. */
export function sameTarget(left: Target, right: Target): boolean {
  return left.channel === right.channel && left.accountId === right.accountId && left.conversationId === right.conversationId
}

/** The DSH session id for one conversation. Deterministic and collision-resistant. */
export function sessionIdFor(target: Pick<Target, 'channel' | 'accountId' | 'conversationId'>): string {
  const digest = createHash('sha1').update(lineKey({ channel: target.channel, accountId: target.accountId, conversationId: target.conversationId })).digest('hex').slice(0, 16)
  return `chan-${target.channel}-${digest}`
}

/** Side sessions (summaries, digests) must never share the conversation's line. */
export function sideSessionIdFor(target: Pick<Target, 'channel' | 'accountId' | 'conversationId'>, kind: string): string {
  const digest = createHash('sha1').update(`${lineKey({ channel: target.channel, accountId: target.accountId, conversationId: target.conversationId })}|${kind}`).digest('hex').slice(0, 16)
  return `chan-${target.channel}-${kind}-${digest}`
}

/** `weixin` + account, used by rate limiters that are per account. */
export function accountKey(channel: ChannelId, accountId: string): string {
  return `${channel}|${accountId}`
}
