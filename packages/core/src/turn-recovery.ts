/** Read an exact submitted input's outcome without activating or resubmitting its agent. */
import { readSessionEvents, type SessionPersistence } from './session-reader.js'
import { MAX_PRODUCED_FILES } from './media.js'
import type { HostPort } from './host.js'
import { TurnProgress, type TurnProgressSnapshot } from './turn-progress.js'
import type { PresentedFile, TurnReply } from './turns.js'

export interface TurnBinding {
  sessionId: string
  messageId: string
  beforeSeq: number
}

export interface RecoveryCursor {
  progress: TurnProgressSnapshot
  deliverables: PresentedFile[]
  deliverablesIncomplete?: boolean
}

export async function recoverTurn(host: HostPort, binding: TurnBinding, workingDirectory: string, signal: AbortSignal, cursor?: RecoveryCursor): Promise<{ reply?: TurnReply; cursor: RecoveryCursor }> {
  const persistence = host.get<SessionPersistence>('sessionPersistence')
  if (!persistence) throw new Error('host session persistence is unavailable')
  const progress = cursor ? TurnProgress.restore(cursor.progress) : new TurnProgress(binding.beforeSeq, binding.messageId)
  const deliverables = cursor?.deliverables.slice() ?? []
  let deliverablesIncomplete = cursor?.deliverablesIncomplete === true
  for await (const event of readSessionEvents(persistence, binding.sessionId, workingDirectory, progress.nextSeq, signal)) {
    progress.update([event])
    if (progress.result) break
    if (event.type !== 'deliverables/presented') continue
    const data = event.data as { turn?: unknown; files?: unknown } | undefined
    if (typeof data?.turn !== 'number' || !progress.matchesTurn(data.turn)) continue
    for (const file of Array.isArray(data.files) ? data.files : []) {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') continue
      if (deliverables.some((existing) => existing.path === file.path)) continue
      if (deliverables.length < MAX_PRODUCED_FILES) deliverables.push({ path: file.path })
      else deliverablesIncomplete = true
    }
  }
  signal.throwIfAborted()
  return {
    cursor: { progress: progress.snapshot(Infinity), deliverables, deliverablesIncomplete },
    ...(progress.result === undefined ? {} : { reply: { ...progress.result, sessionId: binding.sessionId, settled: true, cancelled: progress.cancelled, deliverables, deliverablesIncomplete } }),
  }
}
