/**
 * Session attachment, leasing and idle-agent pruning.
 *
 * A chat turn needs an agent attached to its derived session, but that is a
 * different concern from driving the turn: which live agent to adopt, when to
 * resume versus create, how many idle handles to keep, and when a handle may
 * be disposed. Keeping the pool separate leaves TurnDriver to the turn itself.
 *
 * @module @derekluo/dsh-channels/agent-pool
 */
import fs from 'node:fs'
import path from 'node:path'

import type { HostPort } from './host.js'
import { sessionIdFor } from './ids.js'
import type { Target } from './types.js'

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

export type MessageFactory = (fields: Record<string, unknown>) => unknown

export interface Attached {
  handle: AgentHandle
  sessionId: string
  created?: boolean
  named?: boolean
}

export interface AgentPoolOptions {
  host: HostPort
  logger: { info: (line: string) => void; warn: (line: string) => void }
  workingDirectory: string
  /** Injected in tests; defaults to the host's `createUserMessage`. */
  createUserMessage?: MessageFactory
  /** Called once per conversation when its session is attached or created. */
  onAttach?: (target: Target, sessionId: string, workingDirectory: string) => void
  /** True once the driver is disposed; attach must not adopt a handle then. */
  isDisposed?: () => boolean
}

/** How many idle handles and cached attachments one process keeps. */
const SESSION_LIMIT = 32

export class AgentPool {
  readonly #options: AgentPoolOptions
  readonly #host: HostPort
  readonly #attached = new Map<string, Attached>()
  readonly #owned = new Map<AgentHandle, string>()
  readonly #leases = new Map<string, number>()

  constructor(options: AgentPoolOptions) {
    this.#options = options
    this.#host = options.host
  }

  get logger(): AgentPoolOptions['logger'] {
    return this.#options.logger
  }

  /**
   * The host's current default model selection, as `agentOptions`.
   *
   * A session created without one has no provider/model and its very first step
   * fails with "agent has no provider/model" — an error that reaches the person
   * as a reply. `agentDefaultModel.currentSelection()` is the host's own answer,
   * so it needs no per-plugin configuration.
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

  agents(): AgentsService | undefined {
    return this.#host.get<AgentsService>('agents') ?? undefined
  }

  async factory(): Promise<MessageFactory> {
    if (this.#options.createUserMessage !== undefined) return this.#options.createUserMessage
    // The host package only resolves inside a DSH profile, and it is not a
    // dependency of this package: a variable specifier keeps the import lazy and
    // lets a host without it fail with a clear message instead of at load time.
    const moduleName = '@deepseek-ai/dsh-llm'
    const module = (await import(moduleName)) as { createUserMessage?: MessageFactory }
    if (typeof module.createUserMessage !== 'function') throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
    return module.createUserMessage
  }

  /** Mark one session as in use by a running turn so pruning leaves it alone. */
  retain(sessionId: string): void {
    this.#leases.set(sessionId, (this.#leases.get(sessionId) ?? 0) + 1)
  }

  release(sessionId: string): void {
    const remaining = (this.#leases.get(sessionId) ?? 1) - 1
    if (remaining === 0) this.#leases.delete(sessionId)
    else this.#leases.set(sessionId, remaining)
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
  async attach(
    target: Target,
    options: { system?: string; sessionId?: string; workingDirectory?: string; signal?: AbortSignal } = {},
    isRunning: (agent: AgentHandle['agent']) => boolean = () => false,
  ): Promise<Attached> {
    const sessionId = options.sessionId ?? sessionIdFor(target)
    const workingDirectory = options.workingDirectory ?? this.#options.workingDirectory
    const canonical = (directory: string): string => { try { return fs.realpathSync(directory) } catch { return path.resolve(directory) } }
    const checkDirectory = (agent: AgentHandle['agent']): void => {
      const cwd = agent.session?.header?.cwd
      if (cwd !== undefined && canonical(cwd) !== canonical(workingDirectory)) throw new Error('session working directory differs from selected project')
    }
    const known = this.#attached.get(sessionId)

    if (this.#options.isDisposed?.() === true) throw new Error('the turn driver is disposed')
    const agents = this.agents()
    if (agents === undefined) throw new Error('the agents service is not available')
    const live = agents.get?.(sessionId)
    if (known !== undefined && (typeof agents.get !== 'function' || known.handle.agent === live)) {
      checkDirectory(known.handle.agent)
      return this.#remember(target, known, workingDirectory, isRunning)
    }
    if (live !== undefined) {
      checkDirectory(live as AgentHandle['agent'])
      const attached = { handle: { agent: live as AgentHandle['agent'] }, sessionId }
      return this.#remember(target, attached, workingDirectory, isRunning)
    }

    // The preset is what gives the agent its tool set. A session created
    // without one gets the bare default, so tools would be missing.
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

    if (typeof agents.resume === 'function') {
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
    if (options.signal?.aborted || this.#options.isDisposed?.() === true) {
      await handle.dispose?.()
      throw new Error('the turn driver is disposed')
    }
    this.#owned.set(handle, sessionId)
    return this.#remember(target, { handle, sessionId, created }, workingDirectory, isRunning)
  }

  async #remember(target: Target, attached: Attached, workingDirectory: string, isRunning: (agent: AgentHandle['agent']) => boolean): Promise<Attached> {
    const { sessionId } = attached
    const changed = this.#attached.get(sessionId) !== attached
    this.#attached.delete(sessionId)
    this.#attached.set(sessionId, attached)
    if (changed) {
      try { this.#options.onAttach?.(target, sessionId, workingDirectory) }
      catch { /* Cosmetic grouping cannot fail a turn. */ }
    }
    await this.prune(sessionId, isRunning)
    return attached
  }

  /** Dispose idle handles beyond the limit; a leased or running handle is kept. */
  async prune(keepId?: string, isRunning: (agent: AgentHandle['agent']) => boolean = () => false): Promise<void> {
    for (const [handle, id] of this.#owned) {
      if (this.#owned.size <= SESSION_LIMIT) break
      if (id === keepId || this.#leases.has(id) || handle.agent.status !== 'idle' || isRunning(handle.agent)) continue
      this.#owned.delete(handle)
      if (this.#attached.get(id)?.handle === handle) this.#attached.delete(id)
      try { await handle.dispose?.() } catch (error) { this.logger.warn(`idle agent disposal failed: ${String(error)}`) }
    }
    for (const [id, attached] of this.#attached) {
      if (this.#attached.size <= SESSION_LIMIT) break
      if (id !== keepId && !this.#leases.has(id) && !this.#owned.has(attached.handle)) this.#attached.delete(id)
    }
  }

  async dispose(): Promise<void> {
    const handles = [...this.#owned.keys()]
    this.#owned.clear()
    this.#attached.clear()
    this.#leases.clear()
    await Promise.all(handles.map(async (handle) => {
      try { await handle.dispose?.() } catch (error) { this.#options.logger.warn(`agent disposal failed: ${String(error)}`) }
    }))
  }
}
