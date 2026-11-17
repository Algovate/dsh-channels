/**
 * Driving one agent turn from one chat message.
 *
 * The rules here were learned the hard way on the reference implementation
 * (`dsh-plugin-weixin`) and are kept even where this milestone does not need
 * them yet:
 *
 *  - the session id is derived from the conversation, so a restart resumes the
 *    same line instead of opening a new one;
 *  - resume first, create second, and retry once when the GUI already created
 *    the same session (it opens the very session this plugin is about to);
 *  - persona goes to the system prompt, per-turn context goes through
 *    `agent.inject()`; the person's message stays their own words;
 *  - the inbound message's `source.kind` is the channel id, so the UI can claim
 *    it; `kind: 'user'` may not carry extra fields (the session format
 *    validates it down to `kind`/`rpcId`/`clientTimeZone`).
 *
 * M0 reads the reply by polling `session.snapshotEvents()`. The event-driven
 * wakeup (`session/event`) is the M1 work item; the polling interval is a
 * constant so swapping it is one place.
 *
 * @module @rodin/dsh-channels/turns
 */
import type { InboundMessage, Target } from './types.js'
import { sessionIdFor } from './ids.js'
import { inboundTextWithMedia } from './media.js'
import { extractDocumentText } from './documents.js'
import type { InboundMedia } from './types.js'

/** What `agents.create` / `agents.get` hand back, as far as this module cares. */
export interface AgentHandle {
  agent: {
    session?: { id?: string; snapshotEvents?: () => Array<Record<string, unknown>> } | undefined
    inject?: (message: unknown) => void
    followup?: (message: unknown) => void
    steer?: (message: unknown) => void
  }
  dispose?: () => Promise<void> | void
}

export interface AgentsService {
  /** The live agent for a session, or undefined when nothing is running it. */
  get?: (sessionId: string) => unknown
  /** Load a persisted session back into an agent (cold start). */
  resume?: (options: Record<string, unknown>) => Promise<AgentHandle>
  create?: (options: Record<string, unknown>) => Promise<AgentHandle>
}

export interface TurnReply {
  text: string
  sessionId: string
  failed?: boolean
}

export interface TurnContextBlock {
  name: string
  text: string
}

export interface TurnRequest {
  message: InboundMessage
  /** Stable persona/style text for the system prompt. */
  system?: string
  /** Per-turn blocks, injected as one sourced snapshot before the message. */
  context?: TurnContextBlock[]
  signal?: AbortSignal
}

export interface TurnDriverOptions {
  ctx: { get?: (name: string) => unknown }
  logger: { info: (line: string) => void; warn: (line: string) => void }
  /** Agent working directory (the session's cwd). */
  workingDirectory: string
  maxTurnWaitMs?: number
  pollMs?: number
  /** Injected in tests; defaults to the host's `createUserMessage`. */
  createUserMessage?: (fields: Record<string, unknown>) => unknown
  /** Called once per conversation when its session is attached or created. */
  onAttach?: (target: Target, sessionId: string) => void
  /** Extract document text for inbound files; a failure keeps the path-only note. */
  documentChars?: number
  /** The name this conversation's session gets in the GUI list, once. */
  titleFor?: (message: InboundMessage) => string
}

type MessageFactory = (fields: Record<string, unknown>) => unknown

interface Attached {
  handle: AgentHandle
  sessionId: string
}

/** The reply text carried by one `assistant/message` event, or undefined. */
export function assistantTextOf(event: Record<string, unknown>): string | undefined {
  if (event['type'] !== 'assistant/message') return undefined
  const data = event['data'] as Record<string, unknown> | undefined
  const message = (data?.['message'] ?? data) as Record<string, unknown> | undefined
  const content = message?.['content']
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((block): block is { type: string; text: string } => (block as { type?: unknown })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
  return texts.length === 0 ? undefined : texts.join('\n').trim()
}

export class TurnDriver {
  readonly #options: TurnDriverOptions
  readonly #attached = new Map<string, Attached>()

  constructor(options: TurnDriverOptions) {
    this.#options = options
  }

  get logger(): TurnDriverOptions['logger'] {
    return this.#options.logger
  }

  /**
   * The host's current default model selection, as `agentOptions`.
   *
   * A session created without one has no provider/model and its very first step
   * fails with "agent has no provider/model" — an error that reaches the person
   * as a reply. `agentDefaultModel.currentSelection()` is the host's own answer,
   * so it needs no per-plugin configuration and follows whatever the operator
   * picked in the GUI.
   */
  #defaultRoute(): { provider: string; model: string } | undefined {
    const defaults = this.#options.ctx.get?.('agentDefaultModel') as
      | { currentSelection?: () => { provider?: string; model?: string } | undefined }
      | undefined
    try {
      const selection = defaults?.currentSelection?.()
      if (typeof selection?.provider === 'string' && selection.provider !== '' && typeof selection.model === 'string' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // A host without this service is not an error: the agent may still have
      // a route from its preset.
    }
    return undefined
  }

  #agents(): AgentsService | undefined {
    const service = this.#options.ctx.get?.('agents')
    return service !== undefined && service !== null ? (service as AgentsService) : undefined
  }

  async #factory(): Promise<MessageFactory> {
    if (this.#options.createUserMessage !== undefined) return this.#options.createUserMessage
    // The host package only resolves inside a DSH profile, and it is not a
    // dependency of this package: a variable specifier keeps the import lazy and
    // lets a host without it fail with a clear message instead of at load time.
    const moduleName = '@deepseek-ai/dsh-llm'
    const module = (await import(moduleName)) as { createUserMessage?: MessageFactory }
    if (typeof module.createUserMessage !== 'function') throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
    return module.createUserMessage
  }

  /**
   * Attach the conversation's session.
   *
   * Order matters and each step exists for a failure that was observed:
   *  1. a live agent (the GUI opened this very session) — adopt it;
   *  2. otherwise resume the persisted session — this is the normal cold start;
   *  3. otherwise create it;
   *  4. if create says the session already exists (a resume race), resume again.
   * Skipping step 2 is what made a restart fail with `session already exists`.
   */
  async attach(target: Target, options: { system?: string } = {}): Promise<Attached> {
    const sessionId = sessionIdFor(target)
    const known = this.#attached.get(sessionId)
    if (known !== undefined) return known

    const agents = this.#agents()
    if (agents === undefined) throw new Error('the agents service is not available')

    // The preset is what gives the agent its tool set. A session created
    // without one gets the bare default (a working-directory tool and little
    // else), so `ask_user_question`, bash and the rest would be missing — the
    // first thing a real turn exposes.
    const presets = this.#options.ctx.get?.('agentPresets') as
      | { resolve?: (id: undefined) => Promise<{ id?: string } | undefined>; mount?: (agentCtx: unknown, id: string) => Promise<unknown> }
      | undefined
    let presetId: string | undefined
    try {
      const resolved = await presets?.resolve?.(undefined)
      if (typeof resolved?.id === 'string' && resolved.id !== '') presetId = resolved.id
    } catch (error) {
      this.#options.logger.warn(`agentPresets.resolve failed (continuing without a preset): ${String((error as Error)?.message ?? error)}`)
    }

    const setup = async (agentCtx: Record<string, unknown>): Promise<void> => {
      if (presetId !== undefined && typeof presets?.mount === 'function') {
        try {
          await presets.mount(agentCtx, presetId)
        } catch (error) {
          this.#options.logger.warn(`agentPresets.mount(${presetId}) failed: ${String((error as Error)?.message ?? error)}`)
        }
      }
      const systemPrompt = agentCtx['systemPrompt'] as { section?: (options: Record<string, unknown>) => void } | undefined
      if (options.system === undefined || typeof systemPrompt?.section !== 'function') return
      systemPrompt.section({ name: 'channels:persona', order: 60, text: options.system, interpolate: false })
    }
    const route = this.#defaultRoute()
    const routeOptions = route === undefined ? {} : { agentOptions: route }
    const createOptions = {
      sessionId,
      ...routeOptions,
      meta: { cwd: this.#options.workingDirectory },
      setup,
      signal: AbortSignal.timeout(30_000),
    }

    const adopt = (agent: unknown): AgentHandle => ({ agent: agent as AgentHandle['agent'], dispose: () => {} })

    let handle: AgentHandle | undefined
    const live = agents.get?.(sessionId)
    if (live !== undefined) handle = adopt(live)

    if (handle === undefined && typeof agents.resume === 'function') {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, setup, ...routeOptions })
      } catch (error) {
        this.#options.logger.info(`resume of ${sessionId} failed (${String((error as Error)?.message ?? error)}); will create it`)
      }
    }

    if (handle === undefined && typeof agents.create === 'function') {
      try {
        handle = await agents.create(createOptions)
      } catch (error) {
        if (!/already exists/i.test(String((error as Error)?.message ?? error))) throw error
        // A resume raced us (the GUI resumed the same session); try again.
        if (typeof agents.resume === 'function') {
          handle = await agents.resume({ resumeSessionId: sessionId, setup, ...routeOptions })
        } else {
          const again = agents.get?.(sessionId)
          if (again === undefined) throw error
          handle = adopt(again)
        }
      }
    }
    if (handle === undefined) throw new Error('the agents service can neither resume nor create sessions')

    const attached = { handle, sessionId }
    this.#attached.set(sessionId, attached)
    try {
      this.#options.onAttach?.(target, sessionId)
    } catch {
      // A mapping callback cannot be the reason a turn fails.
    }
    return attached
  }

  /** Run one turn and return its reply once the session log carries it. */
  async run(request: TurnRequest): Promise<TurnReply> {
    const { message } = request
    const attached = await this.attach(message, { ...(request.system === undefined ? {} : { system: request.system }) })
    await this.#nameSession(attached, message)
    const factory = await this.#factory()
    const agent = attached.handle.agent

    const blocks = (request.context ?? []).filter((block) => typeof block.text === 'string' && block.text.trim() !== '')
    if (blocks.length > 0 && typeof agent.inject === 'function') {
      agent.inject(
        factory({
          content: [{ type: 'text', text: blocks.map((block) => block.text).join('\n\n') }],
          source: { kind: 'channels-context', form: 'snapshot', sections: blocks },
        }),
      )
    }

    const before = this.#lastSeq(agent)
    if (typeof agent.followup !== 'function') throw new Error('the agent cannot accept a followup message')
    const enriched = await this.#enrichDocuments(message)
    agent.followup(
      factory({
        // Attachments become text the model can act on ("saved here, open it
        // with read_image"); the person's own words stay last.
        content: [{ type: 'text', text: inboundTextWithMedia({ ...message, media: enriched }) }],
        source: {
          kind: message.channel,
          form: 'message',
          conversationId: message.conversationId,
          group: message.group,
          ...(message.group ? { senderId: message.senderId } : {}),
        },
      }),
    )
    const reply = await this.#awaitReply(agent, before, request.signal)
    return { ...reply, sessionId: attached.sessionId }
  }

  /**
   * Give the session a name once.
   *
   * The GUI's conversation list is built from titled sessions; an untitled one
   * created through `agents.create` does not appear there, which made the whole
   * conversation invisible in the very window that is supposed to show it
   * (found on the device). `rename` is a no-op when the host has no such
   * service, and a failure is a log line.
   */
  async #nameSession(attached: { handle: AgentHandle; sessionId: string }, message: InboundMessage): Promise<void> {
    const title = this.#options.titleFor?.(message)
    if (title === undefined || title.trim() === '') return
    const service = this.#options.ctx.get?.('sessionTitle') as { rename?: (session: unknown, title: string) => unknown } | undefined
    if (typeof service?.rename !== 'function') return
    // The host takes the live SESSION OBJECT, not the id: passing the id made
    // it read `undefined.id` and answer `session "undefined" is not live`
    // (observed on the device).
    const session = (attached.handle.agent as { session?: unknown }).session
    if (session === undefined || session === null) return
    try {
      await service.rename(session, title.trim().slice(0, 80))
    } catch (error) {
      this.#options.logger.warn(`could not name the session: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /**
   * Fill in the extracted text of each document attachment.
   *
   * Only `file` items are tried: an image is for `read_image`, a voice note is
   * already transcribed by the adapter when ASR is available, a video has no
   * text. An extraction failure is a log line; the path still reaches the model.
   */
  async #enrichDocuments(message: TurnRequest['message']): Promise<InboundMedia[]> {
    const media = Array.isArray(message.media) ? message.media : []
    if (media.length === 0) return media
    return Promise.all(
      media.map(async (item) => {
        if (item.kind !== 'file' || item.text !== undefined) return item
        const result = await extractDocumentText(item.path, { maxChars: this.#options.documentChars ?? 4000 })
        if (result.ok !== true) {
          this.#options.logger.info(`document text not extracted from ${item.name ?? item.path}: ${result.reason}`)
          return item
        }
        return { ...item, text: result.truncated ? `${result.text}\n…（已截断）` : result.text }
      }),
    )
  }

  #lastSeq(agent: AgentHandle['agent']): number {
    const events = agent.session?.snapshotEvents?.() ?? []
    const last = events[events.length - 1]
    return typeof last?.['seq'] === 'number' ? (last['seq'] as number) : 0
  }

  async #awaitReply(agent: AgentHandle['agent'], before: number, signal?: AbortSignal): Promise<{ text: string; failed?: boolean }> {
    const deadline = Date.now() + (this.#options.maxTurnWaitMs ?? 20 * 60_000)
    const pollMs = this.#options.pollMs ?? 120
    let lastSeq = before
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return { text: '', failed: true }
      const events = agent.session?.snapshotEvents?.() ?? []
      for (const event of events) {
        const seq = typeof event['seq'] === 'number' ? (event['seq'] as number) : 0
        if (seq <= lastSeq) continue
        lastSeq = seq
        const text = assistantTextOf(event)
        if (text !== undefined && text !== '') return { text }
        if (event['type'] === 'turn/end') {
          const reason = (event['data'] as Record<string, unknown> | undefined)?.['reason'] as Record<string, unknown> | undefined
          if (reason?.['kind'] === 'error') {
            const error = reason['error'] as Record<string, unknown> | undefined
            return { text: typeof error?.['message'] === 'string' ? (error['message'] as string) : '回合失败', failed: true }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    this.#options.logger.warn('the turn did not settle before the timeout')
    return { text: '（这个回合超时了，没有拿到回复。）', failed: true }
  }

  /** Forget one attached session (tests, or after a dispose). */
  detach(sessionId: string): void {
    this.#attached.delete(sessionId)
  }
}
