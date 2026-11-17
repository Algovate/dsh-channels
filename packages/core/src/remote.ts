/**
 * The card's view of the host: one Remote namespace, one read method.
 *
 * A browser cannot see the host's adapters, allowlist or journal, and the
 * Settings card is useless as a static explainer. The Host publishes this
 * namespace and the Client calls it; the payload is deliberately plain JSON —
 * no functions, no dates, nothing the wire cannot carry.
 *
 * Read-only on purpose: writing configuration goes through the host's config
 * editor (`configEditor.edit`), which validates and serializes profile writes,
 * rather than through a method here that would have to reimplement it.
 *
 * @module @rodin/dsh-channels/remote
 */
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'

export interface ChannelStatusView {
  id: string
  label: { en: string; zh: string }
  maxTextChars: number
  media: { image: boolean; file: boolean; voice: boolean; video: boolean }
}

export interface StatusPayload {
  stateRoot: string
  channels: ChannelStatusView[]
  allowlist: string[]
  outboxPending: number
  journal: Array<{ at: number; kind: string; state: string; text: string }>
  interactions: { pending: boolean }
}

export interface StatusSource {
  stateRoot: string
  channels(): ChannelStatusView[]
  allowlist(): string[]
  outboxPending(): number
  journalTail(limit: number): Array<{ at: number; kind: string; state: string; text: string }>
  interactionsPending(): boolean
}

/** The marker the gateway reads to expose methods; the decorator equivalent. */
const MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function markRemoteMethods(target: object, names: string[]): void {
  const methods = names.map((method) => Object.freeze({ method, invocation: { kind: 'direct' as const } }))
  Object.defineProperty(target, MARKER, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  })
}

export class ChannelsRemote extends TypertRemoteService {
  readonly #source: StatusSource

  constructor(ctx: unknown, source: StatusSource) {
    super(ctx as never, 'channelsStatus', { namespace: 'channels' })
    this.#source = source
  }

  /** Everything the card renders, computed on the host at call time. */
  async status(): Promise<StatusPayload> {
    try {
      return {
        stateRoot: this.#source.stateRoot,
        channels: this.#source.channels(),
        allowlist: this.#source.allowlist(),
        outboxPending: this.#source.outboxPending(),
        journal: this.#source.journalTail(8),
        interactions: { pending: this.#source.interactionsPending() },
      }
    } catch (error) {
      // A throwing status must render as an error in the card, not as a broken
      // page; the gateway turns RemoteError into a readable message.
      throw new RemoteError('gateway/internal', String((error as Error)?.message ?? error), {})
    }
  }
}

markRemoteMethods(ChannelsRemote.prototype, ['status'])
