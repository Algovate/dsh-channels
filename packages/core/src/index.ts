/**
 * The core plugin: one Cordis plugin, one bundle row.
 *
 * It owns the pipeline and loads the channels named in `config.adapters`. An
 * adapter is a plain library package exporting `createAdapter()`, not another
 * loader row: adding a channel must not add a second mount that can outlive or
 * shadow the core.
 *
 * Nothing here may fail the host: a missing adapter package, a channel that
 * cannot start, an expired credential — each is a warning, and the plugin stays
 * loaded so the settings card can say what is wrong.
 *
 * @module @derekluo/dsh-channels
 */
import fs from 'node:fs'
import path from 'node:path'

import { statePath } from './store/layout.js'
import { readManagementBody } from './management.js'

import { Config as CoreConfig, resolveConfig, type ChannelsConfig } from './config.js'
import { answerApproval } from './interaction/approval.js'
import type { StatusPayload } from './status.js'
import { saveConfigOverlay, readConfigState } from './store/root.js'
import { DomainCounterStore, FileCounterStore, type CounterStore } from './store/counters.js'
import { loadChannelsDomainSpec } from './store/domain.js'
import { answerUserQuestion, type AskUserQuestionItem } from './interaction/questions.js'
import { createLogger } from './log.js'
import { ChannelsRuntime } from './runtime.js'
import { createHostPort, type HostContext } from './host.js'
import { stateRoot } from './store/root.js'
import type { AdapterModule, ChannelAdapter } from './types.js'

export type * from './types.js'

export const name = 'channels'
export const inject = ['agents']
export const Config = CoreConfig

/** Structural slice of the Cordis context this plugin touches. */
export interface PluginContext extends HostContext {}

export interface ChannelPlugin {
  runtime: ChannelsRuntime
  adapters: ChannelAdapter[]
  dispose(): Promise<void>
}

export function managementRejection(ctx: PluginContext, headers: Record<string, string | string[] | undefined>): number | undefined {
  const connection = createHostPort(ctx).get<{ requestRejection?: (request: { headers: typeof headers }) => number | undefined }>('connection')
  if (typeof connection?.requestRejection !== 'function') return 503
  try { return connection.requestRejection({ headers }) } catch { return 503 }
}

function ensureDirectories(root: string): void {
  for (const directory of ['logs', 'workspace', 'media/inbound', 'journal']) {
    try {
      fs.mkdirSync(path.join(root, directory), { recursive: true })
    } catch {
      // A read-only state root is the operator's problem; the card reports it.
    }
  }
}

/**
 * Build the runtime and start every configured adapter.
 *
 * Exported separately from `apply` so a test can drive the whole pipeline with
 * a fake adapter and a fake agents service, without the loader.
 */
export async function startChannels({ ctx, config }: { ctx: PluginContext; config: ChannelsConfig }): Promise<ChannelPlugin> {
  const root = stateRoot()
  ensureDirectories(root)
  const logger = createLogger({ stateRoot: root, ...(ctx === undefined ? {} : { ctx }) })
  // The operator's `workingDirectory` wins; the state root's own `workspace` is
  // the default, so a channel can never write into a directory the user did not
  // choose for it.
  const workingDirectory = config.workingDirectory !== '' ? config.workingDirectory : path.join(root, 'workspace')
  const counters = await openCounters({ ctx, root, logger })
  const workspace = await registerWorkspace({ ctx, workingDirectory, logger })
  const workspaces = new Map([[path.resolve(workingDirectory), Promise.resolve(workspace)]])
  const runtime = new ChannelsRuntime({
    ctx,
    config,
    logger,
    stateRoot: root,
    workingDirectory,
    counters,
    ...(workspace === undefined
      ? {}
      : {
          attachToWorkspace: (sessionId: string, directory = workingDirectory) => {
            const key = path.resolve(directory)
            let registered = workspaces.get(key)
            if (registered === undefined) {
              registered = registerWorkspace({ ctx, workingDirectory: directory, logger })
              workspaces.set(key, registered)
            }
            void registered.then((group) => group?.attachSession?.(sessionId as never)).catch((error: unknown) => {
              logger.info(`session ${sessionId} not grouped under its workspace: ${String(error)}`)
            })
          },
        }),
  })
  const adapters: ChannelAdapter[] = []
  const loaded: Array<{ adapter: ChannelAdapter; disposer: () => void }> = []
  const sink = runtime.ingress()

  for (const spec of config.adapters) {
    try {
      const module = (await import(spec)) as Partial<AdapterModule>
      if (typeof module.createAdapter !== 'function') {
        logger.warn(`adapter '${spec}' does not export createAdapter()`)
        continue
      }
      const adapter = await module.createAdapter({
        ctx,
        runtime,
        stateRoot: root,
        config: config.adapterConfig[spec] ?? {},
      })
      if (runtime.adapters().some((existing) => existing.id === adapter.id)) throw new Error(`duplicate channel id: ${adapter.id}`)
      if (typeof adapter.startWithSink !== 'function') throw new Error('adapter must implement startWithSink(sink); legacy start/onInbound is no longer supported')
      const disposer = runtime.register(adapter)
      loaded.push({ adapter, disposer })
      adapters.push(adapter)
    } catch (error) {
      logger.warn(`adapter '${spec}' could not be loaded: ${String((error as Error)?.message ?? error)}`)
    }
  }

  let offSeams: () => void
  try { offSeams = registerInteractionSeams({ ctx, config, runtime, logger }) }
  catch (error) {
    for (const { disposer } of loaded) { try { disposer() } catch (cleanup) { logger.warn(`adapter registration cleanup failed: ${String(cleanup)}`) } }
    await runtime.dispose()
    throw error
  }
  for (const { adapter, disposer } of loaded) {
    try {
      await adapter.startWithSink(sink)
    } catch (error) {
      disposer()
      try { await adapter.stop() } catch (error) { logger.warn(`failed adapter cleanup: ${String(error)}`) }
      adapters.splice(adapters.indexOf(adapter), 1)
      logger.warn(`adapter '${adapter.id}' could not start: ${String((error as Error)?.message ?? error)}`)
    }
  }
  await runtime.resumePending()
  const stopOutbox = runtime.startOutboxRetry()
  const offStatusRoute = registerStatusRoute({ ctx, config, runtime, root, logger })
  const offAllowlistRoute = registerAllowlistRoute({ ctx, runtime, root, logger })
  const offPairingRoute = registerPairingRoute({ ctx, runtime, root, logger })
  const offSettingsRoute = registerSettingsRoute({ ctx, runtime, root, logger })

  return {
    runtime,
    adapters,
    async dispose() {
      offSettingsRoute()
      offPairingRoute()
      offAllowlistRoute()
      offStatusRoute()
      offSeams()
      stopOutbox()
      const stopping = loaded.map(async ({ adapter }) => {
        try {
          await adapter.stop()
        } catch (error) {
          logger.warn(`adapter '${adapter.id}' did not stop cleanly: ${String((error as Error)?.message ?? error)}`)
        }
      })
      await runtime.dispose()
      await Promise.all(stopping)
      for (const { disposer } of loaded) disposer()
    },
  }
}

/**
 * Settings saved next to the credentials, so they survive a reinstall and a
 * card can change them without editing the loader patch.
 *
 * The overlay wins over the loader config for every key it contains: the patch
 * ships defaults (an empty allowlist, a text limit), and a value the operator
 * saved through the UI is the live decision. A patch that must not be
 * overridable is a design mistake, not a merge rule.
 */
export function readConfigOverlay(root: string): Partial<ChannelsConfig> {
  return readConfigState(root) as Partial<ChannelsConfig>
}

/**
 * Wire the two blocking seams into the chat.
 *
 * `prepend: true` and `global: true` are both load-bearing: `prepend` runs
 * before the shipped desktop answerer so the chat prompt and the desktop card
 * appear at the same time, and `global` is required because both seams dispatch
 * in the asking agent's scope — a listener bound to this plugin's own scope
 * would never see a request.
 */
function registerInteractionSeams({
  ctx,
  config,
  runtime,
  logger,
}: {
  ctx: PluginContext
  config: ChannelsConfig
  runtime: ChannelsRuntime
  logger: { info: (line: string) => void; warn: (line: string) => void }
}): () => void {
  const host = createHostPort(ctx)
  if (!host.hasEventBus()) return () => {}
  const offs: Array<() => void> = []
  try {
    offs.push(
      host.on(
        'user-questions/request',
        ((request: { agent?: unknown; questions?: unknown[]; signal?: AbortSignal }, next: () => Promise<unknown>) => {
          const interaction = runtime.interactionForAgent(request?.agent)
          const target = interaction?.target
          // One line per seam call: "the listener never ran" and "it ran for a
          // session this channel does not own" look identical from the phone.
          logger.info(`user-questions/request: target=${target === undefined ? 'none' : `${target.channel}|${target.conversationId}`}`)
          return answerUserQuestion({
            queue: runtime.interactions,
            target,
            questions: (Array.isArray(request?.questions) ? request.questions : []) as AskUserQuestionItem[],
            request: { ...request, ...(interaction === undefined ? {} : { deadlineAt: interaction.deadlineAt, signal: request?.signal === undefined ? interaction.signal : AbortSignal.any([request.signal, interaction.signal]) }) },
            next,
            enabled: config.questionsEnabled,
            logger,
          })
        }) as never,
        { prepend: true, global: true },
      ),
    )
    offs.push(
      host.on(
        'approval/request',
        ((request: { agent?: unknown; toolName?: string; reason?: string; displayReason?: unknown; signal?: AbortSignal }, next: () => Promise<unknown>) => {
          const interaction = runtime.interactionForAgent(request?.agent)
          const target = interaction?.target
          logger.info(`approval/request: tool=${String(request?.toolName ?? '?')} target=${target === undefined ? 'none' : `${target.channel}|${target.conversationId}`}`)
          return answerApproval({
            queue: runtime.interactions,
            target,
            request: { ...request, ...(interaction === undefined ? {} : { deadlineAt: interaction.deadlineAt, signal: request?.signal === undefined ? interaction.signal : AbortSignal.any([request.signal, interaction.signal]) }) },
            next,
            enabled: config.approvalsEnabled,
            logger,
          })
        }) as never,
        { prepend: true, global: true },
      ),
    )
  } catch (error) {
    for (const off of offs) { try { off() } catch (cleanup) { logger.warn(`interaction hook cleanup failed: ${String(cleanup)}`) } }
    throw error
  }
  logger.info(`interaction seams registered (questions=${config.questionsEnabled}, approvals=${config.approvalsEnabled})`)
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        // Unregistering must not fail an unload.
      }
    }
  }
}

async function optionalService<T>(ctx: PluginContext, name: string): Promise<T | undefined> {
  const host = createHostPort(ctx)
  const direct = host.get<T>(name)
  if (direct !== undefined && direct !== null) return direct
  const injectService = (ctx as {
    inject?: (services: string[], callback: (scope: Record<string, unknown>) => void) => unknown
  }).inject
  if (injectService === undefined) return undefined
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: T): void => {
      if (settled) return
      settled = true
      clearImmediate(fallback)
      resolve(value)
    }
    const fallback = setImmediate(() => finish())
    try {
      injectService.call(ctx, [name], (scope) => finish(scope[name] as T | undefined))
    } catch {
      finish()
    }
  })
}

/**
 * Put the channel's working directory in the GUI's project list.
 *
 * The GUI groups sessions under workspace records; without a record, a channel
 * session lands in "Ungrouped" and the person has to know to expand that bucket
 * to find their conversation (seen on the device). `create` is idempotent for a
 * directory that already has a project, and it never touches files.
 */
async function registerWorkspace({
  ctx,
  workingDirectory,
  logger,
}: {
  ctx: PluginContext
  workingDirectory: string
  logger: { info: (line: string) => void; warn: (line: string) => void }
}): Promise<{ attachSession?: (sessionId: string) => Promise<void> } | undefined> {
  type WorkspaceHandle = { id?: string; attachSession?: (sessionId: string) => Promise<void> }
  type Registry = { create?: (dir: string, title?: string) => Promise<unknown> }
  const register = async (registry: Registry | undefined): Promise<WorkspaceHandle | undefined> => {
    if (typeof registry?.create !== 'function') {
      logger.info('workspace registry not available on this host: channel sessions stay ungrouped')
      return undefined
    }
    try {
      const created = (await registry.create(workingDirectory, 'Channels')) as WorkspaceHandle | undefined
      logger.info(`workspace registered for ${workingDirectory}`)
      return created
    } catch (error) {
      // A directory that vanished or a rejected record costs the grouping,
      // never the channel.
      logger.warn(`workspace registration failed for ${workingDirectory}: ${String((error as Error)?.message ?? error)}`)
      return undefined
    }
  }
  return register(await optionalService<Registry>(ctx, 'workspaceRegistry'))
}

/**
 * Where the rate counters live: the host's `channels` storage domain when it is
 * mounted, the plugin's own file otherwise.
 *
 * The domain gives atomic records; limits apply within one runtime. The file keeps
 * a headless or test host working exactly the same way. Both satisfy the same
 * synchronous read the gate needs, because a gate cannot await.
 */
async function openCounters({
  ctx,
  root,
  logger,
}: {
  ctx: PluginContext
  root: string
  logger: { info: (line: string) => void; warn: (line: string) => void }
}): Promise<CounterStore> {
  const fileStore = new FileCounterStore({ stateRoot: root, warn: (line) => logger.warn(line) })
  await fileStore.load()
  type Facet = { open?: (spec: unknown) => Promise<unknown> }
  const storageDomain = await optionalService<Facet>(ctx, 'storageDomain')
  if (typeof storageDomain?.open !== 'function') {
    logger.info('rate counters: plugin file (no storage domain on this host)')
    return fileStore
  }
  try {
    const spec = await loadChannelsDomainSpec()
    if (spec === undefined) {
      logger.info('rate counters: plugin file (storage domain packages unavailable)')
      return fileStore
    }
    const domain = (await storageDomain.open(spec)) as {
      table: (name: string) => { get: (key: string) => { count?: number } | undefined; put: (key: string, value: unknown) => Promise<unknown> }
    }
    const table = domain.table('counters')
    const store = new DomainCounterStore({ table, warn: (line) => logger.warn(line) })
    await store.load()
    logger.info('rate counters: channels storage domain')
    return store
  } catch (error) {
    logger.warn(`storage domain unavailable (${String((error as Error)?.message ?? error)}); counters go to the plugin file`)
    return fileStore
  }
}

type ManagementJson = (status: number, body: unknown) => void

/** The two writes share authentication, origin, bounded JSON reading and teardown. */
function registerWriteRoute({ ctx, path: routePath, logger, accept }: {
  ctx: PluginContext
  path: string
  logger: { info: (line: string) => void; warn: (line: string) => void }
  accept: (parsed: Record<string, unknown>, json: ManagementJson) => void
}): () => void {
  const server = createHostPort(ctx).get<{ register?: (route: unknown) => () => void; getOrigin?: () => string }>('webServer')
  if (typeof server?.register !== 'function') return () => {}
  let origin: string | undefined
  try { origin = server.getOrigin?.() } catch { /* Writes fail closed if the origin is unavailable. */ }
  try {
    const off = server.register({
      path: routePath,
      kind: 'exact',
      handler: (req: { method?: string; headers: Record<string, string | string[] | undefined>; on: (event: string, listener: (chunk?: unknown) => void) => void }, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void }) => {
        const json: ManagementJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        const rejection = managementRejection(ctx, req.headers)
        if (rejection !== undefined) return json(rejection, { ok: false, code: 'authentication' })
        if (req.method !== 'POST') return json(405, { ok: false, code: 'method', detail: 'POST only' })
        if (typeof req.headers['origin'] !== 'string' || req.headers['origin'] === '' || req.headers['origin'] !== origin) return json(403, { ok: false, code: 'origin' })
        readManagementBody(req, (body) => {
          try {
            const parsed: unknown = JSON.parse(body === '' ? '{}' : body)
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
            accept(parsed as Record<string, unknown>, json)
          } catch (error) { json(400, { ok: false, code: 'invalid', detail: String((error as Error)?.message ?? error) }) }
        }, (status) => json(status, { ok: false, code: 'body' }))
      },
    })
    logger.info(`management route registered at POST ${routePath}`)
    return () => { try { off() } catch { /* Teardown cannot fail an unload. */ } }
  } catch (error) {
    logger.warn(`management route ${routePath} not registered: ${String(error)}`)
    return () => {}
  }
}

interface WriteRouteOptions {
  ctx: PluginContext
  runtime: ChannelsRuntime
  root: string
  logger: { info: (line: string) => void; warn: (line: string) => void }
}

function registerAllowlistRoute({ ctx, runtime, root, logger }: WriteRouteOptions): () => void {
  return registerWriteRoute({ ctx, path: '/channels/allowlist', logger, accept: (parsed, json) => {
    const add = typeof parsed.add === 'string' ? parsed.add.trim() : undefined
    const remove = typeof parsed.remove === 'string' ? parsed.remove.trim() : undefined
    const invalid = (value: string | undefined): boolean => value !== undefined && (value === '' || value.length > 200 || /\s/.test(value))
    if (invalid(add) || invalid(remove) || (add === undefined && remove === undefined)) {
      json(400, { ok: false, code: 'invalid', detail: 'add/remove must be a single non-empty sender id' })
      return
    }
    const allowlist = runtime.updateAllowlist({
      ...(add === undefined ? {} : { add }),
      ...(remove === undefined ? {} : { remove }),
    }, (senders) => saveConfigOverlay(root, { allowedSenders: senders }, { warn: (line) => logger.warn(line) }))
    if (allowlist === undefined) return json(500, { ok: false, code: 'persist', detail: 'could not save the allowlist' })
    logger.info(`allowlist updated: ${allowlist.length} sender(s)`)
    json(200, { ok: true, allowlist })
  } })
}

function registerPairingRoute({ ctx, runtime, root, logger }: WriteRouteOptions): () => void {
  return registerWriteRoute({ ctx, path: '/channels/pairing', logger, accept: (parsed, json) => {
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
    const action = parsed.action === 'approve' || parsed.action === 'deny' ? parsed.action : undefined
    if (id === '' || id.length > 64 || action === undefined) {
      json(400, { ok: false, code: 'invalid', detail: 'id and action=approve|deny are required' })
      return
    }
    const result = runtime.resolvePairing(id, action, (patch) => saveConfigOverlay(root, patch, { warn: (line) => logger.warn(line) }))
    if (result === undefined) {
      json(404, { ok: false, code: 'not-found', detail: 'the pairing request expired or the allowlist could not be saved' })
      return
    }
    logger.info(`pairing ${action}d for ${result.senderId}`)
    json(200, { ok: true })
  } })
}

function registerSettingsRoute({ ctx, runtime, root, logger }: WriteRouteOptions): () => void {
  return registerWriteRoute({ ctx, path: '/channels/settings', logger, accept: (parsed, json) => {
    const patch: { senderPerMinute?: number; senderPerDay?: number; autoSendFiles?: boolean; questionsEnabled?: boolean; approvalsEnabled?: boolean } = {}
    const number = (key: 'senderPerMinute' | 'senderPerDay'): void => {
      const value = parsed[key]
      if (value === undefined) return
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) {
        throw new Error(`${key} must be an integer between 0 and 100000`)
      }
      patch[key] = value
    }
    const flag = (key: 'autoSendFiles' | 'questionsEnabled' | 'approvalsEnabled'): void => {
      const value = parsed[key]
      if (value === undefined) return
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
      patch[key] = value
    }
    number('senderPerMinute')
    number('senderPerDay')
    flag('autoSendFiles')
    flag('questionsEnabled')
    flag('approvalsEnabled')
    if (Object.keys(patch).length === 0) return json(400, { ok: false, code: 'empty', detail: 'nothing to change' })
    if (!saveConfigOverlay(root, patch, { warn: (line) => logger.warn(line) })) {
      return json(500, { ok: false, code: 'persist', detail: 'could not save settings' })
    }
    runtime.updateSettings(patch)
    logger.info(`settings updated: ${Object.keys(patch).join(', ')}`)
    json(200, { ok: true, settings: runtime.liveSettings() })
  } })
}

function registerStatusRoute({
  ctx,
  config,
  runtime,
  root,
  logger,
}: {
  ctx: PluginContext
  config: ChannelsConfig
  runtime: ChannelsRuntime
  root: string
  logger: { info: (line: string) => void; warn: (line: string) => void }
}): () => void {
  const webServer = createHostPort(ctx).get<{ register?: (route: unknown) => () => void }>('webServer')
  if (typeof webServer?.register !== 'function') return () => {}
  try {
    const off = webServer.register({
      path: '/channels/status',
      kind: 'exact',
      resource: async (request: Request) => {
        const rejection = managementRejection(ctx, Object.fromEntries(request.headers))
        if (rejection !== undefined) return new Response(null, { status: rejection })
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
        }
        const body = JSON.stringify(await buildStatus({ config, runtime, root }))
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    })
    logger.info('status route registered at /channels/status')
    return () => {
      try {
        off()
      } catch {
        // Unregistering cannot fail an unload.
      }
    }
  } catch (error) {
    logger.warn(`status route not registered: ${String((error as Error)?.message ?? error)}`)
    return () => {}
  }
}

async function buildStatus({
  config,
  runtime,
  root,
}: {
  config: ChannelsConfig
  runtime: ChannelsRuntime
  root: string
}): Promise<StatusPayload> {
  return {
    stateRoot: root,
    channels: await Promise.all(runtime.adapters().map(async (adapter) => ({
        id: adapter.id,
        label: adapter.label,
        accounts: await adapter.accounts.list().then((accounts) => accounts.map((account) => ({
          ...account,
          allowedSenders: (config.allowlistPerAccount[account.accountId] ?? config.allowedSenders).length,
        }))).catch(() => []),
        maxTextChars: adapter.capabilities.maxTextChars ?? config.maxTextChars,
        media: {
          image: adapter.capabilities.media?.image === true,
          file: adapter.capabilities.media?.file === true,
          voice: adapter.capabilities.media?.voice === true,
          video: adapter.capabilities.media?.video === true,
        },
      }))),
    allowlist: [...config.allowedSenders],
    pairings: runtime.pendingPairings().map((pairing) => ({
      id: pairing.id,
      channel: pairing.channel,
      accountId: pairing.accountId,
      conversationId: pairing.conversationId,
      senderId: pairing.senderId,
      at: pairing.at,
      text: pairing.text,
    })),
    inboxPending: runtime.pendingInputs(),
    outboxPending: runtime.outbox.list().length,
    journal:
      runtime.journal
        .outbound()
        .slice(-8)
        .map((entry) => ({ at: Date.now(), kind: 'reply', state: entry.state, text: entry.text.slice(0, 160) })),
    interactions: { pending: runtime.interactions.pendingCount() > 0 },
    settings: runtime.liveSettings(),
  }
}

export async function apply(ctx: PluginContext, raw: Partial<ChannelsConfig> = {}): Promise<() => Promise<void>> {
  const config = resolveConfig({ ...raw, ...readConfigOverlay(stateRoot()) })
  if (!config.enabled) {
    ctx.logger?.info?.('dsh-channels: disabled by configuration; no adapter will start')
    return async () => {}
  }
  const plugin = await startChannels({ ctx, config })
  return async () => {
    await plugin.dispose()
  }
}
