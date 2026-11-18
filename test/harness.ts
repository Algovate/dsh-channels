/**
 * A fake DSH host: an agents service, a session event list, and the injected
 * `createUserMessage`. Everything that needs the real host is out of scope for
 * a unit test — this harness is what keeps the rest of the suite fast.
 */
import { createChannelsRuntime, createFakeUserMessage } from './runtime-helper.js'

export interface FakeEvent {
  seq: number
  type: string
  data?: Record<string, unknown>
  time?: number
}

export interface FakeAgent {
  session: { id: string; seq?: number; snapshotEvents: () => FakeEvent[] }
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
  /** Called when the fake agent receives a followup — the place to "use a tool". */
  onFollowup?: () => void
  /** Files the fake turn declares with `present`; a function runs after onFollowup. */
  deliverables?: Array<{ path: string; description?: string }> | (() => Array<{ path: string; description?: string }>)
}

type FakeSession = { id?: string }
type FakeSessionListener = (session: FakeSession, event: FakeEvent) => void

/**
 * The fake host's event feed.
 *
 * Tests already append to `h.events` directly; overriding `push` keeps those
 * tests honest: the driver sees the same committed event the real host would
 * publish, instead of polling the array.
 */
export class FakeEventLog extends Array<FakeEvent> {
  readonly listeners = new Set<FakeSessionListener>()
  currentSessionId = ''

  override push(...items: FakeEvent[]): number {
    return this.#emit(this.currentSessionId, items)
  }

  /** Append events attributed to one session (the fake agent knows which turn it is). */
  pushFor(sessionId: string, ...items: FakeEvent[]): number {
    this.currentSessionId = sessionId
    return this.#emit(sessionId, items)
  }

  #emit(sessionId: string, items: FakeEvent[]): number {
    const count = super.push(...items)
    const session = { id: sessionId }
    for (const item of items) {
      for (const listener of this.listeners) {
        try { listener(session, item) } catch { /* A test listener cannot fail the fake host. */ }
      }
    }
    return count
  }
}

export function createHarness(options: HarnessOptions = {}) {
  const events = new FakeEventLog()
  const created: Array<Record<string, unknown>> = []
  const injected: unknown[] = []
  const followedUp: Array<{ message: unknown }> = []
  const sections: Array<Record<string, unknown>> = []
  const agents = new Map<string, FakeAgent>()
  let turnNumber = 0
  let snapshotReads = 0

  const makeAgent = (sessionId: string): FakeAgent => {
    if (events.currentSessionId === '') events.currentSessionId = sessionId
    return {
      session: {
        id: sessionId,
        get seq() { return events.length },
        snapshotEvents: () => { snapshotReads++; return events },
      },
      inbox: { clear: () => {} },
      inject: (message) => {
        injected.push(message)
        events.pushFor(sessionId, { seq: events.length + 1, type: 'agent/inbox/spliced', data: {} })
      },
      followup: (message) => {
        events.currentSessionId = sessionId
        followedUp.push({ message })
        options.onFollowup?.()
        if (options.silent === true) return
        // The host settles the turn asynchronously on the same event feed.
        Promise.resolve().then(() => {
          const turn = ++turnNumber
          events.pushFor(sessionId, { seq: events.length + 1, type: 'turn/start', data: { turn } })
          events.pushFor(sessionId, { seq: events.length + 1, type: 'user/message', data: message as Record<string, unknown> })
          events.pushFor(sessionId, {
            seq: events.length + 1,
            type: 'assistant/message',
            data: { turn, message: { content: [{ type: 'text', text: options.reply ?? '好的' }] } },
          })
          const files = typeof options.deliverables === 'function' ? options.deliverables() : options.deliverables
          if (files !== undefined && files.length > 0) {
            events.pushFor(sessionId, {
              seq: events.length + 1,
              type: 'deliverables/presented',
              data: { turn, callId: `present-${turn}`, files },
            })
          }
          events.pushFor(sessionId, { seq: events.length + 1, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
        })
      },
    }
  }

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

  const ctx = {
    get: (name: string) => (name === 'agents' ? agentsService : undefined),
    on: (event: string, listener: (...args: never[]) => unknown) => {
      if (event !== 'session/event') return () => {}
      const wrapped = listener as unknown as FakeSessionListener
      events.listeners.add(wrapped)
      return () => { events.listeners.delete(wrapped) }
    },
  }
  return {
    ctx,
    events,
    created,
    injected,
    followedUp,
    sections,
    agents,
    agentsService,
    snapshotReads: () => snapshotReads,
    createUserMessage: createFakeUserMessage,
    makeRuntime: (config: Record<string, unknown> = {}) =>
      createChannelsRuntime({
        ctx,
        config,
        ...(options.maxTurnWaitMs === undefined ? {} : { maxTurnWaitMs: options.maxTurnWaitMs }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        createUserMessage: createFakeUserMessage,
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
