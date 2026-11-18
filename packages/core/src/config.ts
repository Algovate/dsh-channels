/**
 * The core's configuration, and the resolved form the runtime uses.
 *
 * Deny-by-default lives here: an empty `allowedSenders` (and no per-account
 * override) means nobody can drive the agent. Everything else has a sane
 * default so first run needs one value, not fifteen.
 *
 * @module @derekluo/dsh-channels/config
 */
import z from '@deepseek-ai/schemastery'

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
  projects: {},
}


export const Config = z.object({
  projects: z.dict(z.string()).default(DEFAULTS.projects).description('Project aliases mapped to absolute working directories. The name default is reserved.'),
  enabled: z.boolean().default(DEFAULTS.enabled).description('Start the configured channel adapters when the plugin loads.'),
  allowedSenders: z.array(z.string()).default(DEFAULTS.allowedSenders).description('Sender ids allowed to drive the agent; empty denies everyone.'),
  allowlistPerAccount: z.dict(z.array(z.string())).default(DEFAULTS.allowlistPerAccount).description('Per-account override of allowedSenders (same semantics: empty denies).'),
  allowedChats: z.array(z.string()).default(DEFAULTS.allowedChats).description('Optional conversation allowlist; empty allows any conversation of an allowed sender.'),
  adapters: z.array(z.string()).default(DEFAULTS.adapters).description('Adapter package names to load, in order.'),
  adapterConfig: z.dict(z.any()).default(DEFAULTS.adapterConfig).description('Per-adapter configuration, keyed by package name.'),
  maxTextChars: z.number().default(DEFAULTS.maxTextChars).description('Characters per outbound bubble on channels that do not impose their own limit.'),
  bubbleGapMs: z.number().default(DEFAULTS.bubbleGapMs).description('Pause between bubbles of one reply, so a split reply reads as one answer.'),
  maxTurnWaitMs: z.number().default(DEFAULTS.maxTurnWaitMs).description('How long one turn may run before the reply is reported as timed out.'),
  turnPollMs: z.number().default(DEFAULTS.turnPollMs).description('Reply polling interval.'),
  senderPerMinute: z.number().default(DEFAULTS.senderPerMinute).description('Per sender, per minute. 0 disables the gate.'),
  senderPerDay: z.number().default(DEFAULTS.senderPerDay).description('Per sender, per day. 0 disables the gate.'),
  questionsEnabled: z.boolean().default(DEFAULTS.questionsEnabled).description('Let the agent ask its questions in the chat and take the answer back.'),
  approvalsEnabled: z.boolean().default(DEFAULTS.approvalsEnabled).description('Let the chat approve or reject tool calls (allowed once only).'),
  interactionTimeoutMs: z.number().default(DEFAULTS.interactionTimeoutMs).description('How long one question or approval waits for a chat reply before falling back to the desktop.'),
  autoSendFiles: z.boolean().default(DEFAULTS.autoSendFiles).description('Send files the agent wrote in its working directory during a turn as chat attachments.'),
  maxProducedFiles: z.number().default(DEFAULTS.maxProducedFiles).description('How many produced files one turn may send.'),
  maxProducedBytes: z.number().default(DEFAULTS.maxProducedBytes).description('Largest produced file that is sent (bytes).'),
  workingDirectory: z.string().default(DEFAULTS.workingDirectory).description('Where channel sessions run and their output directories are created. Empty means the plugin state root workspace.'),
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
  projects: Record<string, string>
}

/** Fill missing fields; tolerate a config object from an older version. */
export function resolveConfig(raw: Partial<ChannelsConfig> | undefined): ChannelsConfig {
  const input = raw ?? {}
  return {
    projects: Object.fromEntries(Object.entries(record(input.projects)).filter(([key, value]) => key !== 'default' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(key) && typeof value === 'string' && value.startsWith('/')).map(([key, value]) => [key, (value as string).trim()])),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    allowedSenders: Array.isArray(input.allowedSenders) ? input.allowedSenders.map(String) : [...DEFAULTS.allowedSenders],
    allowlistPerAccount: Object.fromEntries(Object.entries(record(input.allowlistPerAccount)).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).map(String)])),
    allowedChats: Array.isArray(input.allowedChats) ? input.allowedChats.map(String) : [...DEFAULTS.allowedChats],
    adapters: Array.isArray(input.adapters) ? input.adapters.map(String) : [...DEFAULTS.adapters],
    adapterConfig: Object.fromEntries(Object.entries(record(input.adapterConfig)).map(([key, value]) => [key, record(value)])),
    maxTextChars: bounded(input.maxTextChars, DEFAULTS.maxTextChars, 1, 100000),
    bubbleGapMs: bounded(input.bubbleGapMs, DEFAULTS.bubbleGapMs, 0, 2147483647),
    maxTurnWaitMs: bounded(input.maxTurnWaitMs, DEFAULTS.maxTurnWaitMs, 1, 2147483647),
    turnPollMs: bounded(input.turnPollMs, DEFAULTS.turnPollMs, 1, 2147483647),
    senderPerMinute: bounded(input.senderPerMinute, DEFAULTS.senderPerMinute, 0, 100000),
    senderPerDay: bounded(input.senderPerDay, DEFAULTS.senderPerDay, 0, 100000),
    questionsEnabled: typeof input.questionsEnabled === 'boolean' ? input.questionsEnabled : DEFAULTS.questionsEnabled,
    approvalsEnabled: typeof input.approvalsEnabled === 'boolean' ? input.approvalsEnabled : DEFAULTS.approvalsEnabled,
    interactionTimeoutMs: bounded(input.interactionTimeoutMs, DEFAULTS.interactionTimeoutMs, 1, 2147483647),
    autoSendFiles: typeof input.autoSendFiles === 'boolean' ? input.autoSendFiles : DEFAULTS.autoSendFiles,
    maxProducedFiles: bounded(input.maxProducedFiles, DEFAULTS.maxProducedFiles, 0, 10000),
    maxProducedBytes: bounded(input.maxProducedBytes, DEFAULTS.maxProducedBytes, 0, 9007199254740991),
    workingDirectory: typeof input.workingDirectory === 'string' ? input.workingDirectory.trim() : DEFAULTS.workingDirectory,
  }
}

/** Senders allowed to drive one account. An explicit per-account list wins, even when empty. */
export function allowlistFor(config: ChannelsConfig, accountId: string): string[] {
  const scoped = config.allowlistPerAccount[accountId]
  return Array.isArray(scoped) ? scoped : config.allowedSenders
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {}
}
