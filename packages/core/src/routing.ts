/** Own project authorization, session selection, migration and route snapshots together. */
import fs from 'node:fs'
import path from 'node:path'
import { lineKey, sessionIdFor } from './ids.js'
import { chatParagraphs } from './outbound.js'
import { SessionLines, type ChatRouting } from './store/lines.js'
import type { InboxEntry } from './store/inbox.js'
import type { TaskRecord } from './store/tasks.js'
import type { CounterStore } from './store/counters.js'
import type { ChannelsConfig } from './config.js'
import type { InboundMessage } from './types.js'

export type RoutingCommand = 'projects' | 'project' | 'sessions' | 'session' | 'new'
interface RoutingOptions {
  stateRoot: string
  workingDirectory: string
  config: ChannelsConfig
  counters?: CounterStore
  logger: { warn(line: string): void }
}

export class ChannelRoutes {
  readonly #lines: SessionLines
  readonly #options: RoutingOptions
  constructor(options: RoutingOptions) {
    this.#options = options
    this.#lines = new SessionLines(options.stateRoot, options.logger.warn)
  }

  #workspaceFor(project: string): string {
    if (project === 'default') return path.resolve(this.#options.workingDirectory)
    const directory = this.#options.config.projects[project]
    if (!Object.hasOwn(this.#options.config.projects, project) || directory === undefined || !path.isAbsolute(directory)) throw new Error('项目未配置')
    const canonical = fs.realpathSync(directory)
    if (!fs.statSync(canonical).isDirectory()) throw new Error('项目目录不可用')
    return canonical
  }

  #allowedWorkspace(directory: string): boolean {
    return ['default', ...Object.keys(this.#options.config.projects)].some((project) => {
      try { return this.#workspaceFor(project) === directory } catch { return false }
    })
  }

  acceptsQueued(entry: InboxEntry): boolean {
    try { return this.#workspaceFor(entry.project ?? 'default') === (entry.workingDirectory ?? this.#options.workingDirectory) } catch { return false }
  }

  artifactWorkspace(task: TaskRecord): string | undefined {
    const directory = task.workingDirectory ?? path.resolve(this.#options.workingDirectory)
    return this.#allowedWorkspace(directory) ? directory : undefined
  }

  #routing(message: InboundMessage): ChatRouting {
    return this.#lines.routing(lineKey(message),
      Math.floor(this.#options.counters?.get(`line:${lineKey(message)}`) ?? 0))
  }

  #routeKey(project: string, directory: string): string { return project === 'default' ? 'default' : JSON.stringify([project, directory]) }

  snapshot(message: InboundMessage): { sessionId: string; workingDirectory: string; project: string } {
    const state = this.#routing(message)
    const workingDirectory = this.#workspaceFor(state.project)
    const line = state.sessions[this.#routeKey(state.project, workingDirectory)]?.current ?? 0
    const suffix = state.project === 'default' ? (line === 0 ? '' : `#${line}`) : `#project:${this.#routeKey(state.project, workingDirectory)}#${line}`
    return { sessionId: sessionIdFor({ ...message, conversationId: `${message.conversationId}${suffix}` }), workingDirectory, project: state.project }
  }

  command(message: InboundMessage, name: RoutingCommand, args: string): string {
    try {
      const state = this.#routing(message)
      if (name === 'projects') {
        return chatParagraphs('【可用项目】', ...['default', ...Object.keys(this.#options.config.projects)].map((alias) => `${alias}${state.project === alias ? '（当前）' : ''}`), '切换：/project <别名>')
      }
      if (name === 'project') {
        if (!args || !['default', ...Object.keys(this.#options.config.projects)].includes(args)) { return '项目未配置或别名无效，请用 /projects 查看。' }
        this.#workspaceFor(args)
        state.project = args
      } else {
        const routeKey = this.#routeKey(state.project, this.#workspaceFor(state.project))
        const selection = state.sessions[routeKey] ?? { current: 0, max: 0 }
        if (name === 'sessions') {
          const rows = Array.from({ length: Math.min(selection.max + 1, 20) }, (_, index) => selection.max - index)
          if (!rows.includes(selection.current)) rows.push(selection.current)
          return chatParagraphs(`【${state.project} 的会话】`, ...rows.map((line) => `${line}${line === selection.current ? '（当前）' : ''}`), '切换：/session <编号>；新建：/new。显示最近 20 个编号及当前编号。')
        }
        if (name === 'session') {
          if (!/^(0|[1-9]\d{0,15})$/.test(args) || !Number.isSafeInteger(Number(args)) || Number(args) > selection.max) { return '会话编号不存在或无效，请用 /sessions 查看。' }
          selection.current = Number(args)
        } else {
          if (!Number.isSafeInteger(selection.max + 1)) throw new Error('会话编号已达上限')
          selection.current = ++selection.max
        }
        state.sessions[routeKey] = selection
      }
      if (!this.#lines.saveRouting(lineKey(message), state)) {
        return (name === 'new' ? '未能开新会话。后续消息仍会进入原会话，请在 DSH 检查通道状态。' : '切换未能保存，后续消息仍使用原选择。请在 DSH 检查通道状态。')
      }
      const line = state.sessions[this.#routeKey(state.project, this.#workspaceFor(state.project))]?.current ?? 0
      return `${name === 'new' ? '已开新会话' : '已切换'}：${state.project}（第 ${line} 条）。下一条任务使用此选择；已排队任务保持原项目和会话。`
    } catch (error) {
      this.#options.logger.warn(`routing command failed: ${String(error)}`)
      return '切换失败：项目目录或会话状态不可用，未更改选择。请在 DSH 检查配置和 lines.json；可用 /project default 返回默认项目。'
    }
  }

}
