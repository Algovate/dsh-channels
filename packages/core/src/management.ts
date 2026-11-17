/** A bounded UTF-8 body reader for the two authenticated management writes. */
export interface BodyRequest {
  on(event: string, listener: (chunk?: unknown) => void): unknown
  removeListener?(event: string, listener: (chunk?: unknown) => void): unknown
  resume?(): unknown
}

export function readManagementBody(req: BodyRequest, accept: (body: string) => void, reject: (status: number) => void, timeoutMs = 10_000): void {
  const chunks: Buffer[] = []
  let size = 0
  let finished = false
  const cleanup = (): void => {
    clearTimeout(timer)
    req.removeListener?.('data', data)
    req.removeListener?.('end', end)
    req.removeListener?.('aborted', aborted)
    // Keep the error handler until the request is destroyed/drained.
  }
  const fail = (status: number): void => {
    if (finished) return
    finished = true
    chunks.length = 0
    cleanup()
    reject(status)
    req.resume?.()
  }
  const data = (chunk?: unknown): void => {
    if (finished) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.alloc(0)
    size += bytes.length
    if (size > 4096) return fail(413)
    chunks.push(bytes)
  }
  const end = (): void => {
    if (finished) return
    finished = true
    cleanup()
    accept(Buffer.concat(chunks, size).toString('utf8'))
    chunks.length = 0
  }
  const aborted = (): void => fail(400)
  const timer = setTimeout(() => fail(408), timeoutMs)
  timer.unref?.()
  req.on('data', data)
  req.on('end', end)
  req.on('aborted', aborted)
  req.on('error', aborted)
}
