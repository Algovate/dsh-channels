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

export interface TurnProgressSnapshot {
  messageId: string
  lastSeq: number
  activeTurn?: number
  matchingTurn?: number
  inboxIndex?: number
  text: string
  cancelled: boolean
}

/** Incremental host events shared by reply waiting and interaction ownership. */
export class TurnProgress {
  #lastSeq: number
  #activeTurn: number | undefined
  #matchingTurn: number | undefined
  #inboxIndex: number | undefined
  #text = ''
  cancelled = false
  result: { text: string; failed?: boolean } | undefined

  readonly messageId: string
  constructor(before: number, messageId: string) { this.#lastSeq = before; this.messageId = messageId }

  snapshot(): TurnProgressSnapshot {
    return { messageId: this.messageId, lastSeq: this.#lastSeq, activeTurn: this.#activeTurn, matchingTurn: this.#matchingTurn, inboxIndex: this.#inboxIndex, text: this.#text.slice(0, 16000), cancelled: this.cancelled }
  }

  static restore(state: TurnProgressSnapshot): TurnProgress {
    const progress = new TurnProgress(state.lastSeq, state.messageId)
    progress.#activeTurn = state.activeTurn
    progress.#matchingTurn = state.matchingTurn
    progress.#inboxIndex = state.inboxIndex
    progress.#text = state.text
    progress.cancelled = state.cancelled
    return progress
  }

  get nextSeq(): number { return Math.max(0, this.#lastSeq + 1) }

  get ownsActiveTurn(): boolean {
    return this.result === undefined && this.#matchingTurn !== undefined && this.#matchingTurn === this.#activeTurn
  }

  update(events: Array<Record<string, unknown>>): void {
    if (this.result !== undefined) return
    for (const event of events) {
      const seq = event['seq']
      if (typeof seq !== 'number' || seq <= this.#lastSeq) continue
      this.#lastSeq = seq
      const data = event['data'] as Record<string, unknown> | undefined
      const turn = data?.['turn']
      switch (event['type']) {
        case 'turn/start': this.#activeTurn = typeof turn === 'number' ? turn : undefined; break
        case 'agent/inbox/spliced': {
          const start = data?.['start']
          const inserted = data?.['inserted']
          if (data?.['target'] !== 'next-turn' || typeof start !== 'number' || !Array.isArray(inserted)) break
          const index = inserted.findIndex((item: { id?: unknown } | null) => item?.id === this.messageId)
          const removed = typeof data['removedCount'] === 'number' ? data['removedCount'] : 0
          if (index >= 0) this.#inboxIndex = start + index
          else if (this.#inboxIndex !== undefined && start <= this.#inboxIndex) {
            if (this.#inboxIndex < start + removed) {
              if (data['outcome'] === 'canceled') { this.cancelled = true; this.result = { text: '', failed: true }; return }
              this.#matchingTurn = this.#activeTurn
              this.#inboxIndex = undefined
            } else this.#inboxIndex += inserted.length - removed
          }
          break
        }
        case 'user/message': if (data?.['id'] === this.messageId) this.#matchingTurn = this.#activeTurn; break
        case 'assistant/message':
          if (this.#matchingTurn !== undefined && turn === this.#matchingTurn) this.#text = assistantTextOf(event) ?? ''
          break
        case 'turn/end': {
          if (turn === this.#activeTurn) this.#activeTurn = undefined
          if (this.#matchingTurn === undefined || turn !== this.#matchingTurn) break
          const reason = data?.['reason'] as { kind?: string; error?: { message?: unknown } } | undefined
          if (reason?.kind === 'completed' || (reason?.kind === 'max-tokens' && this.#text !== '')) this.result = { text: this.#text }
          else if (reason?.kind === 'aborted') { this.cancelled = true; this.result = { text: '', failed: true } }
          else this.result = { text: typeof reason?.error?.message === 'string' ? reason.error.message : '回合失败', failed: true }
          return
        }
      }
    }
  }
}
