/**
 * The Feishu persistent connection: one WebSocket, driven by gateway config.
 *
 * The gateway is discovered through `pullConnectConfig`, which returns a
 * ticket URL plus the timing the client must follow (ping interval, reconnect
 * count/interval/nonce). Inbound data frames carry the v2.0 event envelope,
 * possibly split into `sum` fragments that must be reassembled by `seq`, and
 * every reassembled event is acknowledged with a protobuf frame whose payload
 * is `{ code: 200 }` — a 500 asks the gateway to redeliver. Control pong
 * frames refresh the timing config; inbound pings need no reply.
 *
 * The socket only owns the connection, fragments, ack and reconnect. It knows
 * nothing about turns or gates: `onEvent` resolves after the core's durable
 * handoff, so the ack cannot confirm a message the runtime did not accept.
 *
 * @module @derekluo/dsh-channels-feishu/socket
 */
import { setTimeout as delay } from 'node:timers/promises'

import { decodeFrame, encodeFrame, FrameType, type Frame } from './proto.js'
import type { FeishuEnvelope } from './normalize.js'
import type { FeishuTransport, TransportLogger } from './transport.js'

/** The browser/undici surface this client uses, narrowed so a test can fake it. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: Uint8Array): void
  close(): void
  terminate?(): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
}

export interface WebSocketConstructor {
  new (url: string): WebSocketLike
  readonly OPEN: number
}

interface FragmentEntry {
  parts: Array<Uint8Array | undefined>
  at: number
}

interface SocketOptions {
  transport: FeishuTransport
  logger: TransportLogger
  /** Called with one reassembled envelope; a rejection makes the ack a 500. */
  onEvent: (envelope: FeishuEnvelope) => Promise<void>
  /** Injected in tests so no real socket is opened. */
  webSocketImpl?: WebSocketConstructor
}

const FRAGMENT_TTL_MS = 10_000
const SWEEP_INTERVAL_MS = 10_000

export class FeishuSocket {
  readonly #transport: FeishuTransport
  readonly #logger: TransportLogger
  readonly #onEvent: SocketOptions['onEvent']
  readonly #WebSocketImpl: WebSocketConstructor
  readonly #fragments = new Map<string, FragmentEntry>()
  #ws: WebSocketLike | undefined
  #run: Promise<void> | undefined
  #stopped = false
  #serviceId = 0
  #pingTimer: ReturnType<typeof setInterval> | undefined
  #sweepTimer: ReturnType<typeof setInterval> | undefined
  #pingIntervalMs = 120_000
  #reconnectIntervalMs = 120_000
  #reconnectNonceMs = 30_000
  #reconnectCount = -1
  #attempts = 0
  #abort = new AbortController()

  constructor(options: SocketOptions) {
    this.#transport = options.transport
    this.#logger = options.logger
    this.#onEvent = options.onEvent
    this.#WebSocketImpl = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor)
  }

  /** Repeated start keeps the existing loop; stop() is what allows a fresh one. */
  start(): void {
    if (this.#run !== undefined) return
    this.#stopped = false
    if (this.#abort.signal.aborted) this.#abort = new AbortController()
    this.#run = this.#loop().catch((error: unknown) => {
      this.#logger.warn(`feishu socket loop ended: ${String((error as Error)?.message ?? error)}`)
    })
    this.#sweepTimer = setInterval(() => this.#sweepFragments(), SWEEP_INTERVAL_MS)
    this.#sweepTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#abort.abort(new Error('Feishu socket stopped'))
    if (this.#pingTimer !== undefined) { clearInterval(this.#pingTimer); this.#pingTimer = undefined }
    if (this.#sweepTimer !== undefined) { clearInterval(this.#sweepTimer); this.#sweepTimer = undefined }
    const socket = this.#ws
    if (socket !== undefined) {
      try { socket.terminate?.() ?? socket.close() } catch { /* Best effort. */ }
    }
    this.#fragments.clear()
    await this.#run?.catch(() => {})
    this.#run = undefined
    this.#ws = undefined
  }

  get connected(): boolean {
    return this.#ws !== undefined && this.#ws.readyState === this.#WebSocketImpl.OPEN
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      let config
      try {
        config = await this.#transport.pullConnectConfig()
      } catch (error) {
        this.#logger.warn(`feishu endpoint discovery failed: ${String((error as Error)?.message ?? error)}`)
        await this.#backoff()
        continue
      }
      this.#pingIntervalMs = Math.max(1_000, config.ClientConfig.PingInterval * 1000)
      this.#reconnectIntervalMs = Math.max(0, config.ClientConfig.ReconnectInterval * 1000)
      this.#reconnectNonceMs = Math.max(0, config.ClientConfig.ReconnectNonce * 1000)
      this.#reconnectCount = config.ClientConfig.ReconnectCount
      try {
        await this.#connect(config.URL)
        this.#attempts = 0
      } catch (error) {
        this.#logger.warn(`feishu websocket connect failed: ${String((error as Error)?.message ?? error)}`)
      }
      if (this.#stopped) break
      await this.#backoff()
    }
  }

  /** Open one socket and resolve when it closes; reject if it never opens. */
  #connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false
      let settled = false
      const serviceId = Number(new URL(url).searchParams.get('service_id') ?? '0')
      let socket: WebSocketLike
      try {
        socket = new this.#WebSocketImpl(url)
      } catch (error) {
        reject(error)
        return
      }
      this.#ws = socket
      // A stop() must release the loop even if the platform never emits 'close'.
      const cleanup = (): void => this.#abort.signal.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        try { socket.terminate?.() ?? socket.close() } catch { /* Best effort. */ }
        resolve()
      }
      this.#abort.signal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', () => {
        opened = true
        this.#serviceId = Number.isFinite(serviceId) ? serviceId : 0
        this.#armPing()
        this.#logger.info('feishu persistent connection established')
      })
      socket.addEventListener('message', (event) => {
        void this.#onRaw(event.data).catch((error: unknown) =>
          this.#logger.warn(`feishu frame handling failed: ${String((error as Error)?.message ?? error)}`))
      })
      socket.addEventListener('error', () => {
        if (!opened && !settled) { settled = true; cleanup(); reject(new Error('websocket error before open')) }
      })
      socket.addEventListener('close', () => {
        if (this.#pingTimer !== undefined) { clearInterval(this.#pingTimer); this.#pingTimer = undefined }
        if (settled) return
        settled = true
        cleanup()
        if (!opened) reject(new Error('websocket closed before open'))
        else {
          this.#logger.warn('feishu persistent connection closed; reconnecting')
          resolve()
        }
      })
    })
  }

  #armPing(): void {
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer)
    this.#pingTimer = setInterval(() => {
      if (!this.connected) return
      this.#send(encodeFrame({
        service: this.#serviceId,
        method: FrameType.control,
        headers: [{ key: 'type', value: 'ping' }],
      }))
    }, this.#pingIntervalMs)
    this.#pingTimer.unref?.()
  }

  async #backoff(): Promise<void> {
    if (this.#reconnectCount >= 0) {
      this.#attempts += 1
      if (this.#attempts > this.#reconnectCount) {
        // The gateway gave a finite retry budget; wait one full interval before re-reading it.
        this.#attempts = 0
      }
    }
    if (this.#stopped) return
    const jitter = this.#reconnectNonceMs * Math.random()
    await delay(this.#reconnectIntervalMs + jitter, undefined, { signal: this.#abort.signal }).catch(() => {})
  }

  #send(bytes: Uint8Array): void {
    if (!this.connected) return
    try { this.#ws?.send(bytes) } catch (error) {
      this.#logger.warn(`feishu frame send failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  async #onRaw(data: unknown): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayLike<number>)
    let frame: Frame
    try {
      frame = decodeFrame(bytes)
    } catch (error) {
      this.#logger.warn(`feishu undecodable frame dropped: ${String((error as Error)?.message ?? error)}`)
      return
    }
    if (frame.method === FrameType.control) {
      this.#handleControl(frame)
      return
    }
    if (frame.method !== FrameType.data) return
    const type = this.#header(frame, 'type')
    if (type !== 'event') return
    const merged = this.#merge(frame)
    if (merged === null) return
    let envelope: FeishuEnvelope
    try {
      envelope = JSON.parse(new TextDecoder().decode(merged)) as FeishuEnvelope
    } catch (error) {
      this.#logger.warn(`feishu event payload was not JSON: ${String((error as Error)?.message ?? error)}`)
      this.#ack(frame, false)
      return
    }
    try {
      await this.#onEvent(envelope)
      this.#ack(frame, true)
    } catch (error) {
      this.#logger.warn(`feishu event handler failed; asking for redelivery: ${String((error as Error)?.message ?? error)}`)
      this.#ack(frame, false)
    }
  }

  #handleControl(frame: Frame): void {
    const type = this.#header(frame, 'type')
    if (type === 'ping') return
    if (type !== 'pong' || frame.payload.length === 0) return
    try {
      const pong = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        PingInterval?: number
        ReconnectCount?: number
        ReconnectInterval?: number
        ReconnectNonce?: number
      }
      if (typeof pong.PingInterval === 'number') this.#pingIntervalMs = Math.max(1_000, pong.PingInterval * 1000)
      if (typeof pong.ReconnectCount === 'number') this.#reconnectCount = pong.ReconnectCount
      if (typeof pong.ReconnectInterval === 'number') this.#reconnectIntervalMs = Math.max(0, pong.ReconnectInterval * 1000)
      if (typeof pong.ReconnectNonce === 'number') this.#reconnectNonceMs = Math.max(0, pong.ReconnectNonce * 1000)
      this.#armPing()
    } catch (error) {
      this.#logger.warn(`feishu invalid pong payload: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /** Reassemble `sum`/`seq` fragments; returns the full payload once complete. */
  #merge(frame: Frame): Uint8Array | null {
    const messageId = this.#header(frame, 'message_id')
    const sum = Number(this.#header(frame, 'sum'))
    const seq = Number(this.#header(frame, 'seq'))
    if (messageId === '' || !Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      throw new Error(`invalid event fragment metadata (message_id: ${messageId || '?'}, sum: ${sum}, seq: ${seq})`)
    }
    let entry = this.#fragments.get(messageId)
    if (entry === undefined) {
      entry = { parts: new Array(sum).fill(undefined), at: Date.now() }
      this.#fragments.set(messageId, entry)
    } else if (entry.parts.length !== sum) {
      throw new Error(`fragment sum ${sum} disagrees with the cached ${entry.parts.length}`)
    }
    entry.parts[seq] = frame.payload
    if (entry.parts.some((part) => part === undefined)) return null
    const merged = concat(entry.parts as Uint8Array[])
    this.#fragments.delete(messageId)
    return merged
  }

  #sweepFragments(): void {
    const now = Date.now()
    for (const [id, entry] of this.#fragments) {
      if (now - entry.at > FRAGMENT_TTL_MS) this.#fragments.delete(id)
    }
  }

  #ack(frame: Frame, ok: boolean): void {
    this.#send(encodeFrame({
      seqId: frame.seqId,
      logId: frame.logId,
      service: frame.service,
      method: FrameType.data,
      headers: frame.headers,
      payload: new TextEncoder().encode(JSON.stringify({ code: ok ? 200 : 500 })),
    }))
  }

  #header(frame: Frame, key: string): string {
    return frame.headers.find((header) => header.key === key)?.value ?? ''
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
