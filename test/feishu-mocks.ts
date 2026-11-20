/**
 * A fake `ws` socket shared by the Feishu adapter tests.
 *
 * Mirrors the surface `FeishuSocket` drives: `on(event, listener)` plus
 * `send`/`terminate`, with `open()`/`message()`/`closeSocket()` to drive it
 * from a test. `instances` records every construction so a test can assert how
 * many connections were opened; call `reset()` in `beforeEach`-style setup.
 */
import type { WebSocketLike } from '../packages/adapter-feishu/src/socket.js'

export class MockWebSocket implements WebSocketLike {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readonly readyState = 1
  readonly sent: Uint8Array[] = []
  terminated = false
  readonly url: string
  #listeners = new Map<string, Array<(data?: unknown) => void>>()

  constructor(url = 'wss://gateway/ws?service_id=7') {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  static reset(): void {
    MockWebSocket.instances.length = 0
  }

  on(type: string, listener: (data?: unknown) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(data)
  }

  open(): void { this.emit('open') }
  message(data: Uint8Array): void { this.emit('message', data) }
  closeSocket(): void { this.emit('close') }
  send(data: Uint8Array): void { this.sent.push(data) }
  close(): void {}
  terminate(): void { this.terminated = true }
}
