/**
 * The only door into the DSH host.
 *
 * Everything the plugin needs from DSH — agents, presets, model defaults,
 * session titles, schedules, persistence, workspace grouping, the web server
 * and connection authorization — is looked up here. Consumers name the service
 * they need and own the structural type; this module owns the lookup and the
 * event bus. An architecture test keeps `ctx.get` / `ctx.on` out of the rest
 * of the core, so a host release changes one file, not every subsystem.
 *
 * @module @derekluo/dsh-channels/host
 */

/** Structural slice of the Cordis context this plugin touches. */
export interface HostContext {
  get?: (name: string) => unknown
  logger?: { info?: (line: string) => void; warn?: (line: string) => void }
  /** Cordis event bus; absent in a bare test context. */
  on?: (event: string, listener: (...args: never[]) => unknown, options?: Record<string, unknown>) => () => void
}

export interface HostPort {
  /** Resolve one host service; the caller supplies the structural type. */
  get<T>(name: string): T | undefined
  /** Subscribe to one host event; a host without a bus returns a no-op. */
  on(event: string, listener: (...args: never[]) => unknown, options?: Record<string, unknown>): () => void
  /** True when the host actually provides an event bus. */
  hasEventBus(): boolean
}

export function createHostPort(ctx: HostContext | undefined): HostPort {
  return {
    get<T>(name: string): T | undefined {
      try {
        return ctx?.get?.(name) as T | undefined
      } catch {
        // A host whose service lookup throws is treated as absent, exactly as
        // the old per-call `?.` chain did.
        return undefined
      }
    },
    on(event, listener, options): () => void {
      if (typeof ctx?.on !== 'function') return () => {}
      try {
        const off = ctx.on(event, listener, options)
        return typeof off === 'function' ? off : () => {}
      } catch {
        return () => {}
      }
    },
    hasEventBus(): boolean {
      return typeof ctx?.on === 'function'
    },
  }
}
