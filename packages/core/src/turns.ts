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
import { AgentPool, type AgentHandle, type AgentsService, type Attached, type MessageFactory } from './agent-pool.js'

export type { AgentHandle, AgentsService } from './agent-pool.js'

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
  /** Recovery saw more declared files than its durable cursor can retain. */
  deliverablesIncomplete?: boolean
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
  readonly #pool: AgentPool
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
    await this.#pool.dispose()
  }

  constructor(options: TurnDriverOptions) {
    this.#options = options
    this.#host = createHostPort(options.ctx)
    this.#pool = new AgentPool({
      host: this.#host,
      logger: options.logger,
      workingDirectory: options.workingDirectory,
      ...(options.createUserMessage === undefined ? {} : { createUserMessage: options.createUserMessage }),
      ...(options.onAttach === undefined ? {} : { onAttach: options.onAttach }),
      isDisposed: () => this.#disposed,
    })
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

  /** Attach the conversation's session through the shared pool. */
  attach(target: Target, options: { system?: string; sessionId?: string; workingDirectory?: string; signal?: AbortSignal } = {}): Promise<Attached> {
    return this.#pool.attach(target, options, (agent) => this.#running.has(agent))
  }

  /** Run one turn and return its reply; a wait timeout detaches without cancelling it. */
  async run(request: TurnRequest & { sessionId?: string }): Promise<TurnReply> {
    const leasedId = request.sessionId ?? sessionIdFor(request.message)
    this.#pool.retain(leasedId)
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
      this.#pool.release(leasedId)
      await this.#pool.prune(undefined, (agent) => this.#running.has(agent))
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
    const factory = await this.#pool.factory()
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

}
