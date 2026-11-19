import type { FileHandle } from 'node:fs/promises'

/** Transfer bounded bytes; callers own descriptor validation, lifetime and cleanup. */
export async function copyBounded(source: FileHandle, destination: FileHandle, maxBytes: number): Promise<void> {
  const buffer = Buffer.alloc(64 * 1024)
  let total = 0
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, maxBytes - total + 1), total)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxBytes) throw new Error('file exceeds size limit')
    await destination.writeFile(buffer.subarray(0, bytesRead))
  }
  if (total === 0) throw new Error('file became empty')
}
