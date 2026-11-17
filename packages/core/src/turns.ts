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
 * @module @derekluo/dsh-channels/turns
 */
import type { InboundMessage, Target } from './types.js'
import { setTimeout as delay } from 'node:timers/promises'
import { TurnProgress } from './turn-progress.js'
export { assistantTextOf } from './turn-progress.js'
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
    cancel?: (cause: { kind: 'user' }, options: { keepInbox: true }) => void
    inbox?: { remove?: (messageId: string) => boolean }
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
  /** The private attachment directory for this particular user message. */
  outputDirectory?: string
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
  created?: boolean
  named?: boolean
}

export class TurnDriver {
  readonly #options: TurnDriverOptions
  readonly #attached = new Map<string, Attached>()
  readonly #owned = new Set<AgentHandle>()
  readonly #running = new Map<AgentHandle['agent'], { message: InboundMessage; progress: TurnProgress; signal: AbortSignal }>()
  #disposed = false
  readonly #shutdown = new AbortController()

  /** Only the host turn consuming this exact input may export its interactions. */
  interactionForAgent(value: unknown): { target: InboundMessage; signal: AbortSignal } | undefined {
    const agent = value as AgentHandle['agent']
    const running = this.#running.get(agent)
    if (running === undefined || running.signal.aborted) return undefined
    running.progress.update(agent.session?.snapshotEvents?.() ?? [])
    return running.progress.ownsActiveTurn ? { target: running.message, signal: running.signal } : undefined
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#shutdown.abort()
    this.#running.clear()
    const handles = [...this.#owned]
    this.#owned.clear()
    this.#attached.clear()
    await Promise.all(handles.map(async (handle) => {
      try { await handle.dispose?.() } catch (error) { this.logger.warn(`agent disposal failed: ${String(error)}`) }
    }))
  }

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
  async attach(target: Target, options: { system?: string; sessionId?: string; signal?: AbortSignal } = {}): Promise<Attached> {
    const sessionId = options.sessionId ?? sessionIdFor(target)
    const known = this.#attached.get(sessionId)

    const agents = this.#agents()
    if (this.#disposed) throw new Error('the turn driver is disposed')
    if (agents === undefined) throw new Error('the agents service is not available')
    const live = agents.get?.(sessionId)
    if (known !== undefined && (typeof agents.get !== 'function' || known.handle.agent === live)) return known
    if (live !== undefined) {
      const attached = { handle: { agent: live as AgentHandle['agent'] }, sessionId }
      this.#attached.set(sessionId, attached)
      this.#options.onAttach?.(target, sessionId)
      return attached
    }

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
      signal: options.signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    }

    const adopt = (agent: unknown): AgentHandle => ({ agent: agent as AgentHandle['agent'], dispose: () => {} })

    let handle: AgentHandle | undefined
    let created = false

    if (handle === undefined && typeof agents.resume === 'function') {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, setup, signal: createOptions.signal, ...routeOptions })
      } catch (error) {
        options.signal?.throwIfAborted()
        this.#options.logger.info(`resume of ${sessionId} failed (${String((error as Error)?.message ?? error)}); will create it`)
      }
    }

    if (handle === undefined && typeof agents.create === 'function') {
      try {
        handle = await agents.create(createOptions)
        created = true
      } catch (error) {
        if (!/already exists/i.test(String((error as Error)?.message ?? error))) throw error
        // A resume raced us (the GUI resumed the same session); try again.
        if (typeof agents.resume === 'function') {
          handle = await agents.resume({ resumeSessionId: sessionId, setup, signal: createOptions.signal, ...routeOptions })
        } else {
          const again = agents.get?.(sessionId)
          if (again === undefined) throw error
          handle = adopt(again)
        }
      }
    }
    if (handle === undefined) throw new Error('the agents service can neither resume nor create sessions')

    if (this.#disposed || options.signal?.aborted) {
      await handle.dispose?.()
      throw new Error('the turn driver is disposed')
    }
    this.#owned.add(handle)
    const attached = { handle, sessionId, created }
    this.#attached.set(sessionId, attached)
    try {
      this.#options.onAttach?.(target, sessionId)
    } catch {
      // A mapping callback cannot be the reason a turn fails.
    }
    return attached
  }

  /** Run one turn and return its reply after the matching turn ends. */
  async run(request: TurnRequest & { sessionId?: string }): Promise<TurnReply> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([deadline.signal, this.#shutdown.signal, ...(request.signal === undefined ? [] : [request.signal])])
    const timer = setTimeout(() => deadline.abort(new Error('the turn timed out')), this.#options.maxTurnWaitMs ?? 20 * 60_000)
    let onAbort!: () => void
    const aborted = new Promise<TurnReply>((resolve) => {
      onAbort = () => resolve({ text: '回合已取消或超时', failed: true, sessionId: request.sessionId ?? sessionIdFor(request.message) })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([this.#run({ ...request, signal }), aborted])
    } finally {
      clearTimeout(timer)
      deadline.abort() // Withdraw prompts on success, failure and timeout alike.
      signal.removeEventListener('abort', onAbort)
    }
  }

  async #run(request: TurnRequest & { sessionId?: string; signal: AbortSignal }): Promise<TurnReply> {
    const { message, signal } = request
    const sessionId = request.sessionId ?? sessionIdFor(message)
    if (signal?.aborted) return { text: '', failed: true, sessionId }
    const attached = await this.attach(message, {
      ...(request.system === undefined ? {} : { system: request.system }),
      sessionId,
      ...(signal === undefined ? {} : { signal }),
    })
    signal?.throwIfAborted()
    await this.#nameSession(attached, message)
    signal?.throwIfAborted()
    const factory = await this.#factory()
    const agent = attached.handle.agent
    if (typeof agent.followup !== 'function') throw new Error('the agent cannot accept a followup message')
    const enriched = await this.#enrichDocuments(message, signal)
    if (signal?.aborted) return { text: '', failed: true, sessionId }

    const blocks = (request.context ?? []).filter((block) => typeof block.text === 'string' && block.text.trim() !== '')
    if (blocks.length > 0 && typeof agent.inject === 'function') {
      agent.inject(
        factory({
          content: [{ type: 'text', text: blocks.map((block) => block.text).join('\n\n') }],
          source: { kind: 'channels-context', form: 'snapshot', sections: blocks },
        }),
      )
    }

    const input = factory({
      // Attachments become text the model can act on ("saved here, open it
      // with read_image"); the person's own words stay last.
      content: [
        ...(request.outputDirectory === undefined ? [] : [{
          type: 'text',
          text: `To attach a file to this chat reply, write it into this turn's output directory: ${request.outputDirectory}. Only put files for this chat in that directory.`,
        }]),
        { type: 'text', text: inboundTextWithMedia({ ...message, media: enriched }) },
      ],
      source: {
        kind: message.channel,
        form: 'message',
        conversationId: message.conversationId,
        group: message.group,
        ...(request.outputDirectory === undefined ? {} : { hasOutputInstruction: true }),
        ...(message.group ? { senderId: message.senderId } : {}),
      },
    })
    const messageId = (input as { id?: unknown } | null)?.id
    if (typeof messageId !== 'string' || messageId === '') throw new Error('the user message has no identity')
    const before = this.#lastSeq(agent)
    if (signal?.aborted) return { text: '', failed: true, sessionId }
    const progress = new TurnProgress(before, messageId)
    const running = { message, progress, signal }
    this.#running.set(agent, running)
    const cancel = (): void => {
      try {
        progress.update(agent.session?.snapshotEvents?.() ?? [])
        if (progress.ownsActiveTurn) agent.cancel?.({ kind: 'user' }, { keepInbox: true })
        else if (progress.result === undefined) agent.inbox?.remove?.(messageId)
      } catch (error) { this.logger.warn(`could not cancel channel input: ${String(error)}`) }
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      agent.followup(input)
      const reply = await this.#awaitReply(agent, progress, signal)
      return { ...reply, sessionId }
    } finally {
      signal.removeEventListener('abort', cancel)
      if (this.#running.get(agent) === running) this.#running.delete(agent)
    }
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
  async #nameSession(attached: Attached, message: InboundMessage): Promise<void> {
    if (!attached.created || attached.named) return
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
      attached.named = true
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
  async #enrichDocuments(message: TurnRequest['message'], signal: AbortSignal): Promise<InboundMedia[]> {
    const media = Array.isArray(message.media) ? message.media : []
    if (media.length === 0) return media
    const enriched: InboundMedia[] = []
    for (const item of media) {
      signal.throwIfAborted()
      if (item.kind !== 'file' || item.text !== undefined) { enriched.push(item); continue }
      const result = await extractDocumentText(item.path, { maxChars: this.#options.documentChars ?? 4000, signal })
      if (!result.ok) {
        this.logger.info(`document text not extracted from ${item.name ?? item.path}: ${result.reason}`)
        enriched.push(item)
      } else enriched.push({ ...item, text: result.truncated ? `${result.text}\n…（已截断）` : result.text })
    }
    return enriched
  }

  #lastSeq(agent: AgentHandle['agent']): number {
    const events = agent.session?.snapshotEvents?.() ?? []
    const last = events[events.length - 1]
    return typeof last?.['seq'] === 'number' ? (last['seq'] as number) : -1
  }

  async #awaitReply(agent: AgentHandle['agent'], progress: TurnProgress, signal: AbortSignal): Promise<{ text: string; failed?: boolean }> {
    while (!signal.aborted) {
      progress.update(agent.session?.snapshotEvents?.() ?? [])
      if (progress.result !== undefined) return progress.result
      try { await delay(this.#options.pollMs ?? 120, undefined, { signal }) }
      catch { return { text: '', failed: true } }
    }
    return { text: '', failed: true }
  }

  /** Forget one attached session (tests, or after a dispose). */
  detach(sessionId: string): void {
    this.#attached.delete(sessionId)
  }
}
