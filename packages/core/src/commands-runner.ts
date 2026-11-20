/**
 * Chat command handling, split out of the runtime.
 *
 * Commands share the runtime's stores but not its turn machinery: they answer
 * in the chat, inspect queues and mutate their own task records. Passing those
 * capabilities explicitly keeps the branching here and the message pipeline in
 * runtime.ts, which is what made both hard to follow.
 *
 * @module @derekluo/dsh-channels/commands-runner
 */
import { answerArtifactCommand } from './artifacts.js'
import { helpText, type CommandName } from './commands.js'
import type { ChannelsConfig } from './config.js'
import type { Delivery } from './delivery.js'
import { sameTarget } from './ids.js'
import type { InteractionQueue } from './interaction/queue.js'
import { chatParagraphs } from './outbound.js'
import type { ChannelRoutes } from './routing.js'
import type { ChannelSchedules } from './schedules.js'
import type { Inbox } from './store/inbox.js'
import type { TaskRecord, Tasks } from './store/tasks.js'
import { taskHistoryText, taskStatusText } from './task-messages.js'
import type { ChannelAdapter, InboundMessage, Outgoing, SendResult } from './types.js'

/** What the queued-input registry needs to expose to a command. */
export interface QueuedInputView {
  blocked?: boolean
  finish?: (accepted: boolean) => void
}

export interface CommandDeps {
  config: ChannelsConfig
  workspace: string
  send: (message: InboundMessage, outgoing: Outgoing) => Promise<SendResult[]>
  canManage: (message: InboundMessage) => boolean
  schedules: Pick<ChannelSchedules, 'command'>
  routes: Pick<ChannelRoutes, 'command' | 'artifactWorkspace' | 'snapshot'>
  tasks: Tasks
  inbox: Inbox
  delivery: Pick<Delivery, 'outbox'>
  interactions: InteractionQueue
  adapters: ReadonlyMap<string, Pick<ChannelAdapter, 'label'>>
  activeTask: (message: InboundMessage) => { record: TaskRecord; controller: AbortController } | undefined
  queuedInput: (id: string) => QueuedInputView | undefined
  dropQueuedInput: (id: string) => void
  authorized: (message: InboundMessage) => boolean
  acceptInbound: (message: InboundMessage) => void
  pendingInputs: (message: InboundMessage) => number
}

export class ChatCommandRunner {
  readonly #deps: CommandDeps

  constructor(deps: CommandDeps) {
    this.#deps = deps
  }

  /** Run one command and answer in the chat. Never starts a turn. */
  async run(message: InboundMessage, name: CommandName, args: string): Promise<void> {
    const deps = this.#deps
    if (name === 'schedule' || name === 'schedules') {
      if (!deps.canManage(message)) { await deps.send(message, { text: '只有管理员可以管理计划。', kind: 'notice' }); return }
      await deps.schedules.command(message, name, args); return
    }
    if (name === 'sessions' || name === 'session') {
      await deps.send(message, { kind: 'notice', text: '已移除手机历史会话切换。请在 DSH 查看历史会话；/new 可开始新会话。' })
      return
    }
    if (name === 'projects' || name === 'project' || name === 'new') {
      if (name !== 'projects' && !deps.canManage(message)) { await deps.send(message, { text: '只有管理员可以切换项目或会话。', kind: 'notice' }); return }
      await deps.send(message, { kind: 'notice', text: deps.routes.command(message, name, args) })
      return
    }
    if (name === 'files' || name === 'resend') {
      await answerArtifactCommand({
        message, name, args, tasks: deps.tasks,
        workspace: deps.workspace,
        workspaceFor: (task) => deps.routes.artifactWorkspace(task),
        maxBytes: deps.config.maxProducedBytes,
        authorized: () => deps.authorized(message),
        send: (outgoing) => deps.send(message, outgoing),
      })
      return
    }
    if (name === 'help') {
      await deps.send(message, { text: helpText(), kind: 'notice' })
      return
    }
    if (name === 'whoami') {
      await deps.send(message, {
        text: chatParagraphs(
          '【当前聊天】',
          `发送者 ID：${message.senderId}`,
          `聊天 ID：${message.conversationId}`,
          `通道：${message.channel}（账号 ${message.accountId}）`,
          `角色：${deps.canManage(message) ? '管理员' : '成员'}`,
          `DSH 会话：${deps.routes.snapshot(message).sessionId}`,
        ),
        kind: 'notice',
      })
      return
    }
    if (name === 'cancel') {
      const active = deps.activeTask(message)
      if (active === undefined || active.record.execution === 'completed') {
        await deps.send(message, { text: '当前没有可停止的任务。', kind: 'notice' })
        return
      }
      if (active.record.senderId !== message.senderId) {
        await deps.send(message, { text: '只有任务发起者可以停止当前任务。', kind: 'notice' })
        return
      }
      active.record = { ...active.record, execution: 'stopping' }
      deps.tasks.update(message, active.record.id, { execution: 'stopping' })
      const notice = deps.send(message, { text: '已请求停止当前任务。排队消息会保留。', kind: 'notice' })
      active.controller.abort('user-cancel')
      await notice
      return
    }
    if (name === 'clear') {
      const entries = deps.inbox.list().filter((entry) => sameTarget(entry.message, message) && entry.message.senderId === message.senderId)
      if (entries.length === 0) {
        await deps.send(message, { text: '你没有尚未开始的排队消息。', kind: 'notice' })
        return
      }
      try { deps.inbox.clear(new Set(entries.map((entry) => entry.id))) }
      catch {
        await deps.send(message, { text: '未能清除排队消息。请在 DSH 检查通道状态后重试。', kind: 'notice' })
        return
      }
      for (const entry of entries) {
        deps.queuedInput(entry.id)?.finish?.(false)
        deps.dropQueuedInput(entry.id)
        deps.acceptInbound(entry.message)
      }
      await deps.send(message, { text: `已清除 ${entries.length} 条你的排队消息。`, kind: 'notice' })
      return
    }
    if (name === 'tasks' || name === 'status') {
      const outbox = deps.delivery.outbox.list().filter((entry) => sameTarget(entry.target, message))
      const context = {
        active: deps.activeTask(message)?.record,
        interaction: deps.interactions.active(message),
        pendingTaskIds: new Set(outbox.flatMap((entry) => entry.taskId === undefined ? [] : [entry.taskId])),
      }
      const text = name === 'tasks'
        ? taskHistoryText(deps.tasks.recent(message, message.group ? message.senderId : undefined), context)
        : taskStatusText({
          channel: deps.adapters.get(message.channel)?.label.zh ?? message.channel,
          latest: deps.tasks.latest(message),
          queued: deps.pendingInputs(message),
          pending: outbox.length,
          promptSending: context.interaction === undefined && deps.interactions.busy(message),
          context,
        })
      const blocked = deps.inbox.list().some((entry) => sameTarget(entry.message, message) && deps.queuedInput(entry.id)?.blocked)
      await deps.send(message, { text: blocked ? `${text}\n\n排队任务暂未开始：请在 DSH 检查项目目录及任务状态存储。` : text, kind: 'notice' })
      return
    }
    const unknown: never = name
    throw new Error(`unknown command: ${String(unknown)}`)
  }
}
