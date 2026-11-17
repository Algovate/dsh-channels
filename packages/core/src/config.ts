/**
 * The core's configuration, and the resolved form the runtime uses.
 *
 * Deny-by-default lives here: an empty `allowedSenders` (and no per-account
 * override) means nobody can drive the agent. Everything else has a sane
 * default so first run needs one value, not fifteen.
 *
 * @module @rodin/dsh-channels/config
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the configured channel adapters when the plugin loads.'),
  allowedSenders: z.array(z.string()).default([]).description('Sender ids allowed to drive the agent; empty denies everyone.'),
  allowlistPerAccount: z.dict(z.array(z.string())).default({}).description('Per-account override of allowedSenders (same semantics: empty denies).'),
  allowedChats: z.array(z.string()).default([]).description('Optional conversation allowlist; empty allows any conversation of an allowed sender.'),
  adapters: z.array(z.string()).default([]).description('Adapter package names to load, in order.'),
  adapterConfig: z.dict(z.any()).default({}).description('Per-adapter configuration, keyed by package name.'),
  maxTextChars: z.number().default(600).description('Characters per outbound bubble on channels that do not impose their own limit.'),
  bubbleGapMs: z.number().default(400).description('Pause between bubbles of one reply, so a split reply reads as one answer.'),
  maxTurnWaitMs: z.number().default(1200000).description('How long one turn may run before the reply is reported as timed out.'),
  turnPollMs: z.number().default(120).description('Reply polling interval (the event-driven wakeup replaces this in M1).'),
  senderPerMinute: z.number().default(6).description('Per sender, per minute. 0 disables the gate.'),
  senderPerDay: z.number().default(60).description('Per sender, per day. 0 disables the gate.'),
})

export interface ChannelsConfig {
  enabled: boolean
  allowedSenders: string[]
  allowlistPerAccount: Record<string, string[]>
  allowedChats: string[]
  adapters: string[]
  adapterConfig: Record<string, Record<string, unknown>>
  maxTextChars: number
  bubbleGapMs: number
  maxTurnWaitMs: number
  turnPollMs: number
  senderPerMinute: number
  senderPerDay: number
}

const DEFAULTS: ChannelsConfig = {
  enabled: true,
  allowedSenders: [],
  allowlistPerAccount: {},
  allowedChats: [],
  adapters: [],
  adapterConfig: {},
  maxTextChars: 600,
  bubbleGapMs: 400,
  maxTurnWaitMs: 1_200_000,
  turnPollMs: 120,
  senderPerMinute: 6,
  senderPerDay: 60,
}

/** Fill missing fields; tolerate a config object from an older version. */
export function resolveConfig(raw: Partial<ChannelsConfig> | undefined): ChannelsConfig {
  const input = raw ?? {}
  return {
    enabled: input.enabled ?? DEFAULTS.enabled,
    allowedSenders: Array.isArray(input.allowedSenders) ? input.allowedSenders.map(String) : DEFAULTS.allowedSenders,
    allowlistPerAccount: input.allowlistPerAccount ?? DEFAULTS.allowlistPerAccount,
    allowedChats: Array.isArray(input.allowedChats) ? input.allowedChats.map(String) : DEFAULTS.allowedChats,
    adapters: Array.isArray(input.adapters) ? input.adapters.map(String) : DEFAULTS.adapters,
    adapterConfig: input.adapterConfig ?? DEFAULTS.adapterConfig,
    maxTextChars: Number.isFinite(input.maxTextChars) ? Number(input.maxTextChars) : DEFAULTS.maxTextChars,
    bubbleGapMs: Number.isFinite(input.bubbleGapMs) ? Number(input.bubbleGapMs) : DEFAULTS.bubbleGapMs,
    maxTurnWaitMs: Number.isFinite(input.maxTurnWaitMs) ? Number(input.maxTurnWaitMs) : DEFAULTS.maxTurnWaitMs,
    turnPollMs: Number.isFinite(input.turnPollMs) ? Number(input.turnPollMs) : DEFAULTS.turnPollMs,
    senderPerMinute: Number.isFinite(input.senderPerMinute) ? Number(input.senderPerMinute) : DEFAULTS.senderPerMinute,
    senderPerDay: Number.isFinite(input.senderPerDay) ? Number(input.senderPerDay) : DEFAULTS.senderPerDay,
  }
}

/** Senders allowed to drive one account. An explicit per-account list wins, even when empty. */
export function allowlistFor(config: ChannelsConfig, accountId: string): string[] {
  const scoped = config.allowlistPerAccount[accountId]
  return Array.isArray(scoped) ? scoped : config.allowedSenders
}
