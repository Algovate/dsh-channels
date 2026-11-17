/**
 * One logger for everything the plugin says.
 *
 * Two destinations on purpose: the host logger (the operator's terminal) and a
 * daily file under the state root (the only place a maintainer can look later).
 * Every line is redacted first — a token that reaches a log line is a token on
 * disk.
 *
 * @module @rodin/dsh-channels/log
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Logger {
  info(line: string): void
  warn(line: string): void
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b([A-Za-z0-9_-]{24,})\b/g, '[redacted]'],
  [/\b(token|secret|password|apikey|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s"'）)]+/gi, '[redacted-url]'],
]

export function redact(line: string): string {
  // Operators need the actual WeChat sender ID to bootstrap the deny-by-default allowlist.
  const source = String(line)
  const refusal = /^(refused weixin message from [A-Za-z0-9_-]{1,200}@im\.wechat: )(.*)$/.exec(source)
  let out = refusal?.[2] ?? source
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return (refusal?.[1] ?? '') + out
}

export interface LoggerOptions {
  stateRoot: string
  ctx?: { logger?: { info?: (line: string) => void; warn?: (line: string) => void } }
  now?: () => number
  /** Overrides file output (tests). */
  write?: (file: string, line: string) => void
}

function dayStamp(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function createLogger({ stateRoot, ctx, now = Date.now, write }: LoggerOptions): Logger {
  const file = (): string => path.join(stateRoot, 'logs', `channels-${dayStamp(now())}.log`)
  const emit = (level: 'info' | 'warn', line: string): void => {
    const text = redact(line)
    const prefixed = `dsh-channels: ${text}`
    if (level === 'warn') ctx?.logger?.warn?.(prefixed)
    else ctx?.logger?.info?.(prefixed)
    const record = `${JSON.stringify({ time: new Date(now()).toISOString(), level, line: text })}\n`
    try {
      if (write !== undefined) {
        write(file(), record)
        return
      }
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.appendFileSync(file(), record, { mode: 0o600 })
    } catch {
      // Logging must never be the reason a turn fails.
    }
  }
  return {
    info: (line) => emit('info', line),
    warn: (line) => emit('warn', line),
  }
}
