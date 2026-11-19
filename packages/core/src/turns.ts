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
 * Replies come from the host's committed `session/event` feed. A bare host
 * without that feed (tests, older embeddings) still falls back to polling
 * `snapshotEvents()`; production DSH always provides the feed.
 *
 * @module @derekluo/dsh-channels/turns
 */
import fs from 'node:fs'
import path from 'node:path'
import type { InboundMessage, Target } from './types.js'
import { createHostPort, type HostContext, type HostPort } from './host.js'
import { setTimeout as delay } from 'node:timers/promises'
import { TurnProgress } from './turn-progress.js'
export { assistantTextOf } from './turn-progress.js'
import { sessionIdFor } from './ids.js'
import { inboundTextWithMedia } from './media.js'
import { extractDocumentText } from './documents.js'
import { recoverTurn, type TurnBinding, type RecoveryCursor } from './turn-recovery.js'
import type { InboundMedia } from './types.js'

/** What `agents.create` / `agents.get` hand back, as far as this module cares. */
export interface AgentHandle {
  agent: {
    status?: 'idle' | 'running'
    session?: { seq?: number; header?: { cwd?: string }; id?: string; snapshotEvents?: (fromSeq?: number) => Array<Record<string, unknown>> } | undefined
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

export interface PresentedFile {
  path: string
  description?: string
}

export interface TurnReply {
  text: string
  sessionId: string
  failed?: boolean
  cancelled?: boolean
  interrupted?: boolean
  settled?: boolean
  /** The wait timed out, but the host turn may still be running. */
  pending?: boolean
  /** Files the host declared through `present` during this turn. */
  deliverables?: PresentedFile[]
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
  /** Snapshot of the configured project chosen when this input was accepted. */
  workingDirectory?: string
  /** Add delivery instructions only to this channel input, never a desktop turn. */
  deliverFiles?: boolean
  signal?: AbortSignal
  /** Called once if the wait timed out and the host turn later settles. */
  onSettled?: (reply: TurnReply) => void
  /** Must durably save this identity before followup is allowed to execute. */
  beforeSubmit?: (binding: TurnBinding) => void
}

export interface TurnDriverOptions {
  ctx: HostContext
  logger: { info: (line: string) => void; warn: (line: string) => void }
  /** Agent working directory (the session's cwd). */
  workingDirectory: string
  /** How long to wait before detaching; a submitted turn keeps running. */
  maxTurnWaitMs?: number
  pollMs?: number
  /** Injected in tests; defaults to the host's `createUserMessage`. */
  createUserMessage?: (fields: Record<string, unknown>) => unknown
  /** Called once per conversation when its session is attached or created. */
  onAttach?: (target: Target, sessionId: string, workingDirectory: string) => void
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

interface RunningTurn {
  agent: AgentHandle['agent']
  messageId: string
  message: InboundMessage
  progress: TurnProgress
  signal: AbortSignal
  deadlineAt: number
  removed: boolean
  deliverables: PresentedFile[]
  resolve: (reply: { text: string; failed?: boolean }) => void
  done: Promise<{ text: string; failed?: boolean }>
}

export class TurnDriver {
  recover(binding: TurnBinding, workingDirectory: string, signal: AbortSignal, cursor?: RecoveryCursor): ReturnType<typeof recoverTurn> {
    return recoverTurn(this.#host, binding, workingDirectory, signal, cursor)
  }

  readonly #options: TurnDriverOptions
  readonly #host: HostPort
  readonly #attached = new Map<string, Attached>()
  readonly #owned = new Map<AgentHandle, string>()
  readonly #leases = new Map<string, number>()
  readonly #running = new Map<AgentHandle['agent'], RunningTurn>()
  /** Session id → the channel turn waiting on it; events carry only the session. */
  readonly #bySession = new Map<string, RunningTurn>()
  #unsubscribe: (() => void) | undefined
  /** True when the host gave us a session event feed; polling is the fallback only. */
  #live = false
  #disposed = false
  readonly #shutdown = new AbortController()

  /** Only the host turn consuming this exact input may export its interactions. */
  interactionForAgent(value: unknown): { target: InboundMessage; signal: AbortSignal; deadlineAt: number } | undefined {
    const agent = value as AgentHandle['agent']
    const running = this.#running.get(agent)
    if (running === undefined || running.signal.aborted) return undefined
    if (!this.#live) this.#refreshProgress(agent, running.progress)
    return running.progress.ownsActiveTurn ? { target: running.message, signal: running.signal, deadlineAt: running.deadlineAt } : undefined
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#shutdown.abort()
    try { this.#unsubscribe?.() } catch { /* Teardown cannot fail an unload. */ }
    this.#unsubscribe = undefined
    this.#live = false
    this.#running.clear()
    this.#bySession.clear()
    const handles = [...this.#owned.keys()]
    this.#owned.clear()
    this.#attached.clear()
    await Promise.all(handles.map(async (handle) => {
      try { await handle.dispose?.() } catch (error) { this.logger.warn(`agent disposal failed: ${String(error)}`) }
    }))
  }

  constructor(options: TurnDriverOptions) {
    this.#options = options
    this.#host = createHostPort(options.ctx)
    if (this.#host.hasEventBus()) {
      try {
        const off = this.#host.on('session/event', ((session: { id?: string }, event: Record<string, unknown>) => {
          this.#observe(session, event)
        }) as never, { global: true })
        if (typeof off === 'function') {
          this.#unsubscribe = off
          this.#live = true
        }
      } catch (error) {
        this.logger.warn(`session event subscription failed; falling back to polling: ${String(error)}`)
      }
    }
  }

  /** Fold one committed host event into the channel turn that is waiting on it. */
  /** Keep only files the host declared for this channel turn, once each. */
  #collectDeliverables(running: RunningTurn, event: Record<string, unknown>): void {
    const data = event['data'] as { turn?: unknown; files?: unknown } | undefined
    if (typeof data?.turn !== 'number' || !running.progress.matchesTurn(data.turn)) return
    for (const item of Array.isArray(data.files) ? data.files : []) {
      if (item === null || typeof item !== 'object') continue
      const file = item as { path?: unknown; description?: unknown }
      if (typeof file.path !== 'string' || file.path === '') continue
      if (running.deliverables.some((existing) => existing.path === file.path)) continue
      running.deliverables.push({
        path: file.path,
        ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
      })
    }
  }

  #observe(session: { id?: string } | undefined, event: Record<string, unknown>): void {
    if (this.#disposed) return
    const id = typeof session?.id === 'string' ? session.id : undefined
    const running = id === undefined ? undefined : this.#bySession.get(id)
    if (running === undefined) return
    try {
      running.progress.update([event])
      if (event['type'] === 'deliverables/presented') this.#collectDeliverables(running, event)
    } catch (error) {
      this.logger.warn(`could not read session event: ${String(error)}`)
    }
    if (running.progress.result !== undefined) running.resolve(running.progress.result)
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
    const defaults = this.#host.get<{ currentSelection?: () => { provider?: string; model?: string } | undefined }>('agentDefaultModel')
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
    const service = this.#host.get<AgentsService>('agents')
    return service ?? undefined
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
  async attach(target: Target, options: { system?: string; sessionId?: string; workingDirectory?: string; signal?: AbortSignal } = {}): Promise<Attached> {
    const sessionId = options.sessionId ?? sessionIdFor(target)
    const workingDirectory = options.workingDirectory ?? this.#options.workingDirectory
    const canonical = (directory: string): string => { try { return fs.realpathSync(directory) } catch { return path.resolve(directory) } }
    const checkDirectory = (agent: AgentHandle['agent']): void => {
      const cwd = agent.session?.header?.cwd
      if (cwd !== undefined && canonical(cwd) !== canonical(workingDirectory)) throw new Error('session working directory differs from selected project')
    }
    const known = this.#attached.get(sessionId)

    const agents = this.#agents()
    if (this.#disposed) throw new Error('the turn driver is disposed')
    if (agents === undefined) throw new Error('the agents service is not available')
    const live = agents.get?.(sessionId)
    if (known !== undefined && (typeof agents.get !== 'function' || known.handle.agent === live)) {
      checkDirectory(known.handle.agent)
      return this.#remember(target, known, workingDirectory)
    }
    if (live !== undefined) {
      checkDirectory(live as AgentHandle['agent'])
      const attached = { handle: { agent: live as AgentHandle['agent'] }, sessionId }
      return this.#remember(target, attached, workingDirectory)
    }

    // The preset is what gives the agent its tool set. A session created
    // without one gets the bare default (a working-directory tool and little
    // else), so `ask_user_question`, bash and the rest would be missing — the
    // first thing a real turn exposes.
    const presets = this.#host.get<{ resolve?: (id: undefined) => Promise<{ id?: string } | undefined>; mount?: (agentCtx: unknown, id: string) => Promise<unknown> }>('agentPresets')
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
      meta: { cwd: options.workingDirectory ?? this.#options.workingDirectory },
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

    try { checkDirectory(handle.agent) }
    catch (error) { await handle.dispose?.(); throw error }
    if (this.#disposed || options.signal?.aborted) {
      await handle.dispose?.()
      throw new Error('the turn driver is disposed')
    }
    this.#owned.set(handle, sessionId)
    return this.#remember(target, { handle, sessionId, created }, workingDirectory)
  }

  async #remember(target: Target, attached: Attached, workingDirectory: string): Promise<Attached> {
    const { sessionId } = attached
    const changed = this.#attached.get(sessionId) !== attached
    this.#attached.delete(sessionId)
    this.#attached.set(sessionId, attached)
    if (changed) {
      try { this.#options.onAttach?.(target, sessionId, workingDirectory) }
      catch { /* Cosmetic grouping cannot fail a turn. */ }
    }
    await this.#prune(sessionId)
    return attached
  }

  /** Run one turn and return its reply; a wait timeout detaches without cancelling it. */
  async run(request: TurnRequest & { sessionId?: string }): Promise<TurnReply> {
    const leasedId = request.sessionId ?? sessionIdFor(request.message)
    this.#leases.set(leasedId, (this.#leases.get(leasedId) ?? 0) + 1)
    const sessionId = request.sessionId ?? sessionIdFor(request.message)
    // `preSubmit` stops an attach that ran past the deadline; `prompt` withdraws
    // interactions when the turn settles. Neither cancels a submitted turn.
    const preSubmit = new AbortController()
    const prompt = new AbortController()
    const signal = AbortSignal.any([preSubmit.signal, this.#shutdown.signal, ...(request.signal === undefined ? [] : [request.signal]), prompt.signal])
    const timeoutMs = this.#options.maxTurnWaitMs ?? 20 * 60_000
    const deadlineAt = Date.now() + timeoutMs
    const lifecycle: { submitted: boolean; running?: RunningTurn; result?: TurnReply } = { submitted: false }
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve('timeout') }, timeoutMs)
    })
    const work = this.#run({ ...request, signal, deadlineAt, lifecycle })
      .catch((error: unknown) => ({ text: String((error as Error)?.message ?? error), failed: true, sessionId }))

    let cancellation: Promise<TurnReply> | undefined
    let onAbort!: () => void
    const aborted = new Promise<TurnReply>((resolve) => {
      onAbort = () => {
        const reply = { text: '回合已取消或超时', failed: true, interrupted: true, sessionId }
        if (lifecycle.result?.settled) { resolve(lifecycle.result); return }
        const state = lifecycle.running
        if (state !== undefined) {
          if (!this.#live) {
            try { this.#refreshProgress(state.agent, state.progress) } catch (error) { this.logger.warn(`could not read final turn state: ${String(error)}`) }
          }
          if (state.progress.result !== undefined) {
            resolve({ ...state.progress.result, sessionId, settled: true, cancelled: state.progress.cancelled, ...(state.deliverables.length === 0 ? {} : { deliverables: state.deliverables }) })
            return
          }
        }
        if (request.signal?.reason === 'user-cancel') {
          cancellation = (async () => {
            if (state === undefined) return { ...reply, cancelled: !lifecycle.submitted }
            for (let attempt = 0; attempt < 50; attempt++) {
              await delay(10)
              if (!this.#live) {
                try { this.#refreshProgress(state.agent, state.progress) } catch { break }
              }
              if (state.removed || state.progress.cancelled) return { ...reply, cancelled: true }
              if (state.progress.result !== undefined) return { ...state.progress.result, sessionId, settled: true, ...(state.deliverables.length === 0 ? {} : { deliverables: state.deliverables }) }
            }
            return { ...reply, cancelled: false }
          })()
          void cancellation.then(resolve)
        } else resolve(reply)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      const winner = await Promise.race([work, timeout, aborted])
      if (winner === 'timeout') {
        const state = lifecycle.running
        if (!lifecycle.submitted) {
          // Nothing has run yet: stop a late attach from submitting after we left.
          preSubmit.abort(new Error('the turn timed out before submission'))
        } else if (state !== undefined && state.progress.queuedInInbox && state.progress.result === undefined) {
          // The input is still queued behind desktop work; remove only that input.
          try { state.removed = state.agent.inbox?.remove?.(state.messageId) === true }
          catch (error) { this.logger.warn(`could not remove timed-out input: ${String(error)}`) }
          state.resolve({ text: '', failed: true })
        }
        void work.then((result) => {
          try { prompt.abort() } catch { /* already aborted */ }
          try { request.onSettled?.(result) } catch (error) { this.logger.warn(`late turn callback failed: ${String(error)}`) }
        })
        return {
          text: '回合等待超时，任务仍在后台处理；结果确认后会继续发送，发 /status 查看。',
          failed: true, interrupted: true, pending: true, settled: false, sessionId,
        }
      }
      return await (cancellation ?? Promise.resolve(winner))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (!timedOut) { try { prompt.abort() } catch { /* already aborted */ } }
      const remaining = (this.#leases.get(leasedId) ?? 1) - 1
      if (remaining === 0) this.#leases.delete(leasedId); else this.#leases.set(leasedId, remaining)
      await this.#prune()
    }
  }

  async #run(request: TurnRequest & { sessionId?: string; signal: AbortSignal; deadlineAt: number; lifecycle: { submitted: boolean; running?: RunningTurn; result?: TurnReply } }): Promise<TurnReply> {
    const { message, signal } = request
    const sessionId = request.sessionId ?? sessionIdFor(message)
    if (signal?.aborted) return { text: '', failed: true, sessionId }
    const attached = await this.attach(message, {
      ...(request.system === undefined ? {} : { system: request.system }),
      sessionId,
      ...(request.workingDirectory === undefined ? {} : { workingDirectory: request.workingDirectory }),
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
        ...(request.deliverFiles === true ? [{
          type: 'text',
          text: 'This request arrived through a chat channel. To deliver final images or other files, call present with the completed files before your final reply. Only present files intended for this chat and inside the current project. A bare filesystem path or ordinary Markdown file link is not accessible on the phone. Inline local Markdown image embeds are also sent as image attachments. Keep the final reply concise and let the channel upload the files.',
        }] : []),
        { type: 'text', text: inboundTextWithMedia({ ...message, media: enriched }) },
      ],
      source: {
        kind: message.channel,
        form: 'message',
        conversationId: message.conversationId,
        group: message.group,
        ...(request.deliverFiles !== true ? {} : { hasOutputInstruction: true }),
        ...(message.group ? { senderId: message.senderId } : {}),
      },
    })
    const messageId = (input as { id?: unknown } | null)?.id
    if (typeof messageId !== 'string' || messageId === '') throw new Error('the user message has no identity')
    const before = this.#lastSeq(agent)
    if (signal?.aborted) return { text: '', failed: true, sessionId }
    request.beforeSubmit?.({ sessionId, messageId, beforeSeq: before })
    const progress = new TurnProgress(before, messageId)
    let resolve!: (reply: { text: string; failed?: boolean }) => void
    const done = new Promise<{ text: string; failed?: boolean }>((settle) => { resolve = settle })
    const running: RunningTurn = { agent, messageId, message, progress, signal, deadlineAt: request.deadlineAt, removed: false, deliverables: [], resolve, done }
    this.#running.set(agent, running)
    this.#bySession.set(sessionId, running)
    request.lifecycle.running = running
    const cancel = (): void => {
      try {
        if (!this.#live) this.#refreshProgress(agent, progress)
        if (progress.ownsActiveTurn) agent.cancel?.({ kind: 'user' }, { keepInbox: true })
        else if (progress.result === undefined) running.removed = agent.inbox?.remove?.(messageId) === true
      } catch (error) { this.logger.warn(`could not cancel channel input: ${String(error)}`) }
    }
    const stopWaiting = (): void => { resolve({ text: '', failed: true }) }
    signal.addEventListener('abort', cancel, { once: true })
    signal.addEventListener('abort', stopWaiting, { once: true })
    try {
      request.lifecycle.submitted = true
      agent.followup(input)
      const reply = await this.#awaitReply(agent, progress, signal, running)
      const result = { ...reply, sessionId, settled: progress.result !== undefined, ...(running.deliverables.length === 0 ? {} : { deliverables: running.deliverables }) }
      request.lifecycle.result = result
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
      signal.removeEventListener('abort', stopWaiting)
      if (this.#running.get(agent) === running) this.#running.delete(agent)
      if (this.#bySession.get(sessionId) === running) this.#bySession.delete(sessionId)
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
    const service = this.#host.get<{ rename?: (session: unknown, title: string) => unknown }>('sessionTitle')
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

  #refreshProgress(agent: AgentHandle['agent'], progress: TurnProgress): void {
    progress.update(agent.session?.snapshotEvents?.(progress.nextSeq) ?? [])
  }

  #lastSeq(agent: AgentHandle['agent']): number {
    const seq = agent.session?.seq
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) return seq - 1
    const events = agent.session?.snapshotEvents?.() ?? []
    const last = events[events.length - 1]
    return typeof last?.['seq'] === 'number' ? (last['seq'] as number) : -1
  }

  async #awaitReply(agent: AgentHandle['agent'], progress: TurnProgress, signal: AbortSignal, running: RunningTurn): Promise<{ text: string; failed?: boolean }> {
    // The host emits committed events synchronously; the subscription was made
    // before followup(), so a fast turn cannot finish before we are listening.
    if (this.#live) return await running.done
    while (!signal.aborted) {
      this.#refreshProgress(agent, progress)
      if (progress.result !== undefined) return progress.result
      try { await delay(this.#options.pollMs ?? 120, undefined, { signal }) }
      catch { return { text: '', failed: true } }
    }
    return { text: '', failed: true }
  }

  /** Bound idle owned agents; active channel turns and live desktop work are never evicted. */
  async #prune(keepId?: string): Promise<void> {
    const limit = 32
    for (const [handle, id] of this.#owned) {
      if (this.#owned.size <= limit) break
      if (id === keepId || this.#leases.has(id) || handle.agent.status !== 'idle' || this.#running.has(handle.agent)) continue
      this.#owned.delete(handle)
      if (this.#attached.get(id)?.handle === handle) this.#attached.delete(id)
      try { await handle.dispose?.() } catch (error) { this.logger.warn(`idle agent disposal failed: ${String(error)}`) }
    }
    for (const [id, attached] of this.#attached) {
      if (this.#attached.size <= limit) break
      if (id !== keepId && !this.#leases.has(id) && !this.#owned.has(attached.handle)) this.#attached.delete(id)
    }
  }
}
