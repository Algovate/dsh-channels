/**
 * A fake whisper bridge process for the ASR tests (both adapters use it).
 *
 * The bridge protocol is one JSON line in, one JSON line out. `answer` decides
 * what the fake writes back; returning `undefined` simulates a bridge that
 * never answers. `children` records every spawn so a test can assert that an
 * unusable bridge was not started.
 */
import { PassThrough } from 'node:stream'

export function fakeSpawn(
  answer: (request: { wav: string }) => string | undefined,
  onSpawn?: (env: Record<string, string | undefined>) => void,
) {
  const children: Array<{ stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void }> = []
  const spawnImpl = ((_command: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
    onSpawn?.(options.env)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      kill: () => { child.exitCode = 0 },
      on: () => child,
      once: () => child,
      off: () => child,
    }
    let buffer = ''
    stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      for (const line of buffer.split('\n')) {
        if (line.trim() === '') continue
        const reply = answer(JSON.parse(line) as { wav: string })
        if (reply !== undefined) stdout.write(reply)
      }
      buffer = ''
    })
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawnImpl, children }
}
