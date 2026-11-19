import fs from 'node:fs'

export interface SessionPersistence {
  open(id: string, access: 'read', options: { signal: AbortSignal }): Promise<{
    header: { cwd?: string }
    read(offset: number, length: number, options: { signal: AbortSignal }): Promise<{ events: Array<Record<string, unknown>> }>
    close(): Promise<void>
  }>
}

/** Read committed events without activating an agent, always releasing the handle. */
export async function* readSessionEvents(persistence: SessionPersistence, sessionId: string, workingDirectory: string, fromSeq: number, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  signal.throwIfAborted()
  const handle = await persistence.open(sessionId, 'read', { signal })
  try {
    signal.throwIfAborted()
    if (!handle.header.cwd || fs.realpathSync(handle.header.cwd) !== fs.realpathSync(workingDirectory)) throw new Error('recovery session directory no longer matches the original project')
    let next = fromSeq
    for (let page = 0; page < 16; page++) {
      signal.throwIfAborted()
      const { events } = await handle.read(next, 256, { signal })
      signal.throwIfAborted()
      if (!events.length) return
      const before = next
      for (const event of events) {
        signal.throwIfAborted()
        if (typeof event.seq === 'number' && event.seq >= next) next = event.seq + 1
        yield event
      }
      if (next <= before) throw new Error('host recovery log did not advance')
    }
  } finally { await handle.close() }
  signal.throwIfAborted()
}
