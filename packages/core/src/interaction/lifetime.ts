/**
 * A desktop answerer may never settle; a cancelled turn must still release its
 * seam. The optional deadline keeps the seam bounded even when the host never
 * aborts its turn: once the turn's wait window is over, nobody can still be
 * expected to answer through it.
 */
export async function withinLifetime<T>(pending: Promise<T>, signal?: AbortSignal, deadlineAt?: number): Promise<T> {
  if (signal === undefined && deadlineAt === undefined) return pending
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason ?? new Error('interaction aborted'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
  const timer = deadlineAt === undefined
    ? undefined
    : setTimeout(() => abort(), Math.max(0, deadlineAt - Date.now()))
  timer?.unref?.()
  try { return await Promise.race([pending, cancelled]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
