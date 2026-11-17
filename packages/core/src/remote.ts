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
 * @module @derekluo/dsh-channels/remote
 */

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
  settings: {
    senderPerMinute: number
    senderPerDay: number
    autoSendFiles: boolean
    questionsEnabled: boolean
    approvalsEnabled: boolean
  }
}

export interface StatusSource {
  stateRoot: string
  channels(): ChannelStatusView[]
  allowlist(): string[]
  outboxPending(): number
  journalTail(limit: number): Array<{ at: number; kind: string; state: string; text: string }>
  interactionsPending(): boolean
  settings(): StatusPayload['settings']
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

/**
 * Build the Remote face when the host can host it.
 *
 * Returns undefined when the protocol package is absent (a test build, or a host
 * without the API layer), and the card then reads the HTTP route instead.
 */
export async function createChannelsRemote(ctx: unknown, source: StatusSource): Promise<{ dispose?: () => void } | undefined> {
  type Base = new (ctx: unknown, name: string, options: { namespace: string }) => object
  let protocol: { TypertRemoteService?: Base } | undefined
  try {
    // A dynamic specifier keeps TypeScript from requiring the optional peer's
    // types in a build where it is not installed.
    const name = '@deepseek-ai/dsh-typert-protocol'
    protocol = (await import(name)) as unknown as typeof protocol
  } catch {
    return undefined
  }
  const Base = protocol?.TypertRemoteService
  if (typeof Base !== 'function') return undefined

  class ChannelsRemote extends Base {
    readonly #source: StatusSource

    constructor(innerCtx: unknown, innerSource: StatusSource) {
      super(innerCtx, 'channelsStatus', { namespace: 'channels' })
      this.#source = innerSource
    }

    async status(): Promise<StatusPayload> {
      return {
        stateRoot: this.#source.stateRoot,
        channels: this.#source.channels(),
        allowlist: this.#source.allowlist(),
        outboxPending: this.#source.outboxPending(),
        journal: this.#source.journalTail(8),
        interactions: { pending: this.#source.interactionsPending() },
        settings: this.#source.settings(),
      }
    }
  }
  markRemoteMethods(ChannelsRemote.prototype, ['status'])
  return new ChannelsRemote(ctx, source) as { dispose?: () => void }
}
