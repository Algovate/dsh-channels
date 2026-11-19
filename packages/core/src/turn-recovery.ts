/** Read an exact submitted input's outcome without activating or resubmitting its agent. */
import fs from 'node:fs'
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
}

interface Persistence {
  open(id: string, access: 'read', options: { signal: AbortSignal }): Promise<{
    header: { cwd?: string }
    read(offset: number, length: number, options: { signal: AbortSignal }): Promise<{ events: Array<Record<string, unknown>> }>
    close(): Promise<void>
  }>
}

export async function recoverTurn(host: HostPort, binding: TurnBinding, workingDirectory: string, signal: AbortSignal, cursor?: RecoveryCursor): Promise<{ reply?: TurnReply; cursor: RecoveryCursor }> {
  const persistence = host.get<Persistence>('sessionPersistence')
  if (!persistence) throw new Error('host session persistence is unavailable')
  signal.throwIfAborted()
  const handle = await persistence.open(binding.sessionId, 'read', { signal })
  const progress = cursor ? TurnProgress.restore(cursor.progress) : new TurnProgress(binding.beforeSeq, binding.messageId)
  const deliverables = cursor?.deliverables.slice() ?? []
  try {
    signal.throwIfAborted()
    if (!handle.header.cwd || fs.realpathSync(handle.header.cwd) !== fs.realpathSync(workingDirectory)) throw new Error('recovery session directory no longer matches the original project')
    for (let page = 0; page < 16 && !progress.result; page++) {
      const before = progress.nextSeq
      const { events } = await handle.read(before, 256, { signal })
      signal.throwIfAborted()
      if (!events.length) break
      for (const event of events) {
        if (progress.result) break
        progress.update([event])
        if (event.type !== 'deliverables/presented') continue
        const data = event.data as { turn?: unknown; files?: unknown } | undefined
        if (typeof data?.turn !== 'number' || !progress.matchesTurn(data.turn)) continue
        for (const file of Array.isArray(data.files) ? data.files : []) {
          if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') continue
          if (deliverables.length < 100 && !deliverables.some((existing) => existing.path === file.path)) deliverables.push({ path: file.path })
        }
      }
      if (progress.nextSeq <= before) throw new Error('host recovery log did not advance')
    }
  } finally { await handle.close() }
  signal.throwIfAborted()
  return {
    cursor: { progress: progress.snapshot(Infinity), deliverables },
    ...(progress.result === undefined ? {} : { reply: { ...progress.result, sessionId: binding.sessionId, settled: true, cancelled: progress.cancelled, deliverables } }),
  }
}
