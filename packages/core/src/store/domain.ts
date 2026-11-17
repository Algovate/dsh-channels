/**
 * The plugin's storage domain.
 *
 * Rate counters belong in a validated, durable, multi-process-safe record store
 * rather than a JSON file the plugin rewrites itself. The domain is declared
 * with the host's `defineDomain` and opened through `ctx.storageDomain`.
 *
 * Both packages are OPTIONAL peers, imported lazily: a test build and a host
 * without the storage domain must load this module without them, and the
 * file-backed counter store is the documented fallback. The specifier is built
 * at runtime so TypeScript does not require a type for an uninstalled peer.
 *
 * @module @rodin/dsh-channels/store/domain
 */

export interface ChannelsDomainSpec {
  name: string
  version: number
  tables: Record<string, unknown>
}

/** The spec the host validates at open; undefined when the packages are absent. */
export async function loadChannelsDomainSpec(): Promise<ChannelsDomainSpec | undefined> {
  const storageModule = '@deepseek-ai/dsh-storage-domain'
  const zodModule = 'zod'
  try {
    const build = (await import(storageModule)) as {
      defineDomain?: (input: unknown) => ChannelsDomainSpec
      domainTable?: (schema: unknown) => unknown
    }
    const z = (await import(zodModule)) as { object?: (shape: Record<string, unknown>) => unknown; number?: () => unknown }
    const defineDomain = build.defineDomain
    const domainTable = build.domainTable
    const zodObject = z.object
    const zodNumber = z.number
    if (typeof defineDomain !== 'function' || typeof domainTable !== 'function' || typeof zodObject !== 'function' || typeof zodNumber !== 'function') return undefined
    const number = (zodNumber as () => { int: () => { nonnegative: () => unknown } })()
    const counterRecord = (zodObject as (shape: Record<string, unknown>) => unknown)({ count: number.int().nonnegative() })
    return defineDomain({ name: 'channels', version: 1, tables: { counters: domainTable(counterRecord) } })
  } catch {
    return undefined
  }
}
