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
  questionsEnabled: z.boolean().default(true).description('Let the agent ask its questions in the chat and take the answer back.'),
  approvalsEnabled: z.boolean().default(true).description('Let the chat approve or reject tool calls (allowed once only).'),
  interactionTimeoutMs: z.number().default(600000).description('How long one question or approval waits for a chat reply before falling back to the desktop.'),
  autoSendFiles: z.boolean().default(true).description('Send files the agent wrote in its working directory during a turn as chat attachments.'),
  maxProducedFiles: z.number().default(3).description('How many produced files one turn may send.'),
  maxProducedBytes: z.number().default(20971520).description('Largest produced file that is sent (bytes).'),
  workingDirectory: z.string().default('').description('Where channel sessions run and where produced files are looked for. Empty means the plugin state root workspace.'),
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
  questionsEnabled: boolean
  approvalsEnabled: boolean
  interactionTimeoutMs: number
  autoSendFiles: boolean
  maxProducedFiles: number
  maxProducedBytes: number
  workingDirectory: string
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
  questionsEnabled: true,
  approvalsEnabled: true,
  interactionTimeoutMs: 600_000,
  autoSendFiles: true,
  maxProducedFiles: 3,
  maxProducedBytes: 20 * 1024 * 1024,
  workingDirectory: '',
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
    questionsEnabled: input.questionsEnabled ?? DEFAULTS.questionsEnabled,
    approvalsEnabled: input.approvalsEnabled ?? DEFAULTS.approvalsEnabled,
    interactionTimeoutMs: Number.isFinite(input.interactionTimeoutMs) ? Number(input.interactionTimeoutMs) : DEFAULTS.interactionTimeoutMs,
    autoSendFiles: input.autoSendFiles ?? DEFAULTS.autoSendFiles,
    maxProducedFiles: Number.isFinite(input.maxProducedFiles) ? Number(input.maxProducedFiles) : DEFAULTS.maxProducedFiles,
    maxProducedBytes: Number.isFinite(input.maxProducedBytes) ? Number(input.maxProducedBytes) : DEFAULTS.maxProducedBytes,
    workingDirectory: typeof input.workingDirectory === 'string' ? input.workingDirectory.trim() : DEFAULTS.workingDirectory,
  }
}

/** Senders allowed to drive one account. An explicit per-account list wins, even when empty. */
export function allowlistFor(config: ChannelsConfig, accountId: string): string[] {
  const scoped = config.allowlistPerAccount[accountId]
  return Array.isArray(scoped) ? scoped : config.allowedSenders
}
