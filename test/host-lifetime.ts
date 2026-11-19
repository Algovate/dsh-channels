import { afterEach, beforeEach } from 'node:test'

/** Standalone interaction tests need the live host handle that production provides. */
export function keepHostAlive(): void {
  let host: ReturnType<typeof setInterval>
  beforeEach(() => { host = setInterval(() => {}, 1000) })
  afterEach(() => clearInterval(host))
}
