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
 * @module @rodin/dsh-channels
 */
import fs from 'node:fs'
import path from 'node:path'

import { Config as CoreConfig, resolveConfig, type ChannelsConfig } from './config.js'
import { answerApproval } from './interaction/approval.js'
import { answerUserQuestion, type AskUserQuestionItem } from './interaction/questions.js'
import { createLogger } from './log.js'
import { ChannelsRuntime } from './runtime.js'
import { stateRoot } from './store/root.js'
import type { AdapterModule, ChannelAdapter } from './types.js'

export type * from './types.js'

export const name = 'channels'
export const inject = ['agents']
export const Config = CoreConfig

/** Structural slice of the Cordis context this plugin touches. */
export interface PluginContext {
  get?: (name: string) => unknown
  logger?: { info?: (line: string) => void; warn?: (line: string) => void }
  /** Cordis event bus; absent in a bare test context. */
  on?: (event: string, listener: (...args: never[]) => unknown, options?: Record<string, unknown>) => () => void
}

export interface ChannelPlugin {
  runtime: ChannelsRuntime
  adapters: ChannelAdapter[]
  dispose(): Promise<void>
}

function ensureDirectories(root: string): void {
  for (const directory of ['logs', 'workspace', 'memory', 'media/inbound', 'journal']) {
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
  const runtime = new ChannelsRuntime({
    ctx,
    config,
    logger,
    stateRoot: root,
    workingDirectory: path.join(root, 'workspace'),
  })
  const adapters: ChannelAdapter[] = []
  const loaded: Array<{ adapter: ChannelAdapter; disposer: () => void }> = []

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
      const disposer = runtime.register(adapter)
      const off = adapter.onInbound((message) => {
        runtime.dispatch(message)
      })
      loaded.push({ adapter, disposer: () => {
        off()
        disposer()
      } })
      adapters.push(adapter)
    } catch (error) {
      logger.warn(`adapter '${spec}' could not be loaded: ${String((error as Error)?.message ?? error)}`)
    }
  }

  for (const { adapter } of loaded) {
    try {
      await adapter.start()
    } catch (error) {
      logger.warn(`adapter '${adapter.id}' could not start: ${String((error as Error)?.message ?? error)}`)
    }
  }
  const stopOutbox = runtime.startOutboxRetry()
  const offSeams = registerInteractionSeams({ ctx, config, runtime, logger })

  return {
    runtime,
    adapters,
    async dispose() {
      offSeams()
      stopOutbox()
      runtime.dispose()
      for (const { adapter } of loaded) {
        try {
          await adapter.stop()
        } catch (error) {
          logger.warn(`adapter '${adapter.id}' did not stop cleanly: ${String((error as Error)?.message ?? error)}`)
        }
      }
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
  const file = path.join(root, 'config.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return parsed !== null && typeof parsed === 'object' ? (parsed as Partial<ChannelsConfig>) : {}
  } catch {
    return {}
  }
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
  if (typeof ctx.on !== 'function') return () => {}
  const offs: Array<() => void> = []
  offs.push(
    ctx.on(
      'user-questions/request',
      ((request: { agent?: unknown; questions?: unknown[]; signal?: AbortSignal }, next: () => Promise<unknown>) => {
        const target = runtime.targetForAgent(request?.agent)
        // One line per seam call: "the listener never ran" and "it ran for a
        // session this channel does not own" look identical from the phone.
        logger.info(`user-questions/request: target=${target === undefined ? 'none' : `${target.channel}|${target.conversationId}`}`)
        return answerUserQuestion({
          queue: runtime.interactions,
          target,
          questions: (Array.isArray(request?.questions) ? request.questions : []) as AskUserQuestionItem[],
          request: request ?? {},
          next,
          enabled: config.questionsEnabled,
          logger,
        })
      }) as never,
      { prepend: true, global: true },
    ),
  )
  offs.push(
    ctx.on(
      'approval/request',
      ((request: { agent?: unknown; toolName?: string; reason?: string; displayReason?: unknown; signal?: AbortSignal }, next: () => Promise<unknown>) => {
        const target = runtime.targetForAgent(request?.agent)
        logger.info(`approval/request: tool=${String(request?.toolName ?? '?')} target=${target === undefined ? 'none' : `${target.channel}|${target.conversationId}`}`)
        return answerApproval({
          queue: runtime.interactions,
          target,
          request: request ?? {},
          next,
          enabled: config.approvalsEnabled,
          logger,
        })
      }) as never,
      { prepend: true, global: true },
    ),
  )
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
