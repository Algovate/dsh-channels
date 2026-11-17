/**
 * A fake DSH host: an agents service, a session event list, and the injected
 * `createUserMessage`. Everything that needs the real host is out of scope for
 * a unit test — this harness is what keeps the rest of the suite fast.
 */
import { createChannelsRuntime } from './runtime-helper.js'

export interface FakeEvent {
  seq: number
  type: string
  data?: Record<string, unknown>
  time?: number
}

export interface FakeAgent {
  session: { id: string; snapshotEvents: () => FakeEvent[] }
  inbox: { clear: () => void }
  inject: (message: unknown) => void
  followup: (message: unknown) => void
  steer?: (message: unknown) => void
}

export interface HarnessOptions {
  /** Reply the fake agent produces after `followup`. */
  reply?: string
  /** When true the fake agent never writes a reply (timeout test). */
  silent?: boolean
  /** Existing sessions by id, to test resume-vs-create. */
  existing?: string[]
  maxTurnWaitMs?: number
  pollMs?: number
}

export function createHarness(options: HarnessOptions = {}) {
  const events: FakeEvent[] = []
  const created: Array<Record<string, unknown>> = []
  const injected: unknown[] = []
  const followedUp: Array<{ message: unknown }> = []
  const sections: Array<Record<string, unknown>> = []
  const agents = new Map<string, FakeAgent>()

  const makeAgent = (sessionId: string): FakeAgent => ({
    session: { id: sessionId, snapshotEvents: () => events },
    inbox: { clear: () => {} },
    inject: (message) => {
      injected.push(message)
      events.push({ seq: events.length + 1, type: 'agent/inbox/spliced', data: {} })
    },
    followup: (message) => {
      followedUp.push({ message })
      events.push({ seq: events.length + 1, type: 'user/message', data: { message } })
      if (options.silent === true) return
      // The host settles the turn asynchronously; the driver polls until it sees this.
      Promise.resolve().then(() => {
        events.push({
          seq: events.length + 1,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: options.reply ?? '好的' }] } },
        })
        events.push({ seq: events.length + 1, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      })
    },
  })

  for (const id of options.existing ?? []) agents.set(id, makeAgent(id))

  const persisted = new Set<string>(options.existing ?? [])
  const agentsService = {
    // The host's `get` answers the live agent itself, not a handle.
    get: (sessionId: string) => agents.get(sessionId),
    // A persisted session can be resumed; an unknown id cannot.
    async resume(resumeOptions: Record<string, unknown>) {
      const sessionId = String(resumeOptions['resumeSessionId'])
      if (!persisted.has(sessionId)) throw new Error(`session "${sessionId}" not found`)
      const setup = resumeOptions['setup'] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined
      await setup?.({ systemPrompt: { section: (section: Record<string, unknown>) => sections.push(section) } })
      const agent = agents.get(sessionId) ?? makeAgent(sessionId)
      agents.set(sessionId, agent)
      return { agent, dispose: async () => {} }
    },
    async create(createOptions: Record<string, unknown>) {
      created.push(createOptions)
      const sessionId = String(createOptions['sessionId'])
      if (agents.has(sessionId)) throw new Error(`Session "${sessionId}" already exists`)
      const setup = createOptions['setup'] as ((ctx: Record<string, unknown>) => Promise<void>) | undefined
      await setup?.({ systemPrompt: { section: (section: Record<string, unknown>) => sections.push(section) } })
      const agent = makeAgent(sessionId)
      agents.set(sessionId, agent)
      return { agent, dispose: async () => {} }
    },
    remove: (sessionId: string) => agents.delete(sessionId),
  }

  const ctx = { get: (name: string) => (name === 'agents' ? agentsService : undefined) }
  const createUserMessage = (fields: Record<string, unknown>): Record<string, unknown> => fields

  return {
    ctx,
    events,
    created,
    injected,
    followedUp,
    sections,
    agents,
    agentsService,
    createUserMessage,
    makeRuntime: (config: Record<string, unknown> = {}) =>
      createChannelsRuntime({
        ctx,
        config,
        ...(options.maxTurnWaitMs === undefined ? {} : { maxTurnWaitMs: options.maxTurnWaitMs }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        createUserMessage,
      }),
  }
}

/** The message shape every test starts from. */
export function inbound(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'fake',
    accountId: 'acct',
    conversationId: 'conv',
    senderId: 'sender',
    text: '你好',
    media: [],
    group: false,
    at: Date.now(),
    ...overrides,
  }
}
