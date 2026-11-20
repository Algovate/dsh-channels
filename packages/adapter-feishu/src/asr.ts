/**
 * Voice notes → text, through a long-lived Python bridge.
 *
 * `bin/asr-transcribe.py` is the in-repo bridge (MIT): one JSON request per
 * line on stdin, one JSON answer per line on stdout, whisper behind it
 * (mlx-whisper on Apple silicon, faster-whisper elsewhere). Feishu voice notes
 * arrive as Ogg/Opus, which whisper decodes directly, so no pre-conversion is
 * needed. Spawning the bridge once and keeping it alive matters: the first
 * transcription warms a model, later ones answer in a few hundred
 * milliseconds, and a per-message `python3` spawn would pay that cost every time.
 *
 * Everything here degrades: no python, no script, no model, a timeout — the
 * voice note still reaches the person as an audio path, and the model is told
 * the audio could not be transcribed rather than being handed an empty
 * transcript.
 *
 * @module @derekluo/dsh-channels-feishu/asr
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'

export type Transcription = { ok: true; text: string } | { ok: false; reason: string }

export interface AsrOptions {
  command?: string
  scriptPath: string
  modelDir: string
  language?: string
  timeoutMs?: number
  logger: { info: (line: string) => void; warn: (line: string) => void }
  spawnImpl?: typeof spawn
}

export class AsrBridge {
  readonly #options: AsrOptions
  #child: ChildProcessWithoutNullStreams | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #broken = false

  constructor(options: AsrOptions) {
    this.#options = options
  }

  /** True when the bridge can be used at all (script present, python found). */
  available(): boolean {
    if (this.#broken) return false
    try {
      fs.accessSync(this.#options.scriptPath, fs.constants.R_OK)
    } catch {
      return false
    }
    return true
  }

  #spawn(): ChildProcessWithoutNullStreams | undefined {
    if (this.#child !== undefined && this.#child.exitCode === null) return this.#child
    const command = this.#options.command ?? 'python3'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_FEISHU_ASR_MODEL_DIR: this.#options.modelDir,
      ...(this.#options.language === undefined ? {} : { DSH_FEISHU_ASR_LANGUAGE: this.#options.language }),
    }
    try {
      const child = (this.#options.spawnImpl ?? spawn)(command, [this.#options.scriptPath], { env, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
      child.stdin.on('error', () => {}) // A closed pipe must not crash the host.
      child.stderr.on('data', (chunk: Buffer) => this.#options.logger.info(`asr: ${String(chunk).trim().slice(0, 200)}`))
      child.on('exit', (code) => {
        this.#options.logger.info(`asr bridge exited (${String(code)})`)
        if (this.#child === child) this.#child = undefined
      })
      child.on('error', (error) => {
        this.#options.logger.warn(`asr bridge failed to start: ${String(error)}`)
        this.#broken = true
        if (this.#child === child) this.#child = undefined
      })
      this.#child = child
      return child
    } catch (error) {
      this.#options.logger.warn(`asr bridge could not spawn: ${String((error as Error)?.message ?? error)}`)
      this.#broken = true
      return undefined
    }
  }

  /**
   * Transcribe one audio file (Feishu voice is Ogg/Opus). Never throws and never rejects: a failure is a value,
   * because the message must still go through.
   */
  transcribe(wavPath: string): Promise<Transcription> {
    if (this.#closed) return Promise.resolve({ ok: false, reason: 'bridge closed' })
    if (!this.available()) return Promise.resolve({ ok: false, reason: 'bridge unavailable' })
    const run = async (): Promise<Transcription> => {
      if (this.#closed) return { ok: false, reason: 'bridge closed' }
      const child = this.#spawn()
      if (child === undefined) return { ok: false, reason: 'bridge unavailable' }
      return new Promise<Transcription>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup()
          // A stuck model must not hold the message forever; the next request
          // starts a fresh process.
          this.#child = undefined
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
          resolve({ ok: false, reason: 'transcription timed out' })
        }, this.#options.timeoutMs ?? 60_000)
        const decoder = new StringDecoder('utf8')
        let buffered = ''
        let bytes = 0
        const protocolError = (reason: string): void => {
          cleanup()
          // Discard the stream so a partial/oversized answer cannot become the next request's reply.
          if (this.#child === child) this.#child = undefined
          try { child.kill('SIGKILL') } catch { /* Already exited. */ }
          resolve({ ok: false, reason })
        }
        const onData = (chunk: Buffer): void => {
          bytes += chunk.length
          if (bytes > 256 * 1024) return protocolError('ASR answer exceeds 262144 bytes')
          buffered += decoder.write(chunk)
          let newline: number
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            if (line === '') continue
            // The engines write diagnostics such as "Detected language: …" to
            // stdout, so only a JSON object is a protocol answer.
            if (!line.startsWith('{')) {
              this.#options.logger.info(`asr: ${line.slice(0, 200)}`)
              continue
            }
            try {
              const parsed = JSON.parse(line) as { ok?: boolean; text?: string; error?: string }
              cleanup()
              resolve(parsed.ok === true && typeof parsed.text === 'string' ? { ok: true, text: parsed.text } : { ok: false, reason: parsed.error ?? 'no text' })
            } catch { protocolError(`unreadable answer: ${line.slice(0, 120)}`) }
            return
          }
        }
        const onExit = (): void => {
          cleanup()
          resolve({ ok: false, reason: 'bridge exited before answering' })
        }
        const cleanup = (): void => {
          clearTimeout(timeout)
          child.stdout.off('data', onData)
          child.off('exit', onExit)
          child.off('error', onExit)
          child.stdin.off('error', onExit)
        }
        child.stdout.on('data', onData)
        child.on('exit', onExit)
        child.on('error', onExit)
        child.stdin.on('error', onExit)
        child.stdin.write(`${JSON.stringify({ wav: path.resolve(wavPath) })}\n`)
      })
    }
    // One request in flight: the bridge transcribes on one thread, and the line
    // protocol has no request id — the next line out is this request's answer.
    const next = this.#queue.then(run, run)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async dispose(): Promise<void> {
    this.#closed = true
    const child = this.#child
    this.#child = undefined
    if (child === undefined) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve()
      }, 2000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.end()
      } catch {
        // The pipe may already be closed.
      }
    })
  }
}
