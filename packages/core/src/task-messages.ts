/** Chat views for task state. The runtime supplies a snapshot scoped to the current chat. */
import type { InteractionKind } from './interaction/queue.js'
import { chatParagraphs } from './outbound.js'
import type { Journal } from './store/journal.js'
import type { TaskRecord } from './store/tasks.js'

interface TaskMessageContext {
  active: TaskRecord | undefined
  interaction: InteractionKind | undefined
  pendingTaskIds: ReadonlySet<string>
}

function taskLabels(saved: TaskRecord, context: TaskMessageContext) {
  const active = context.active?.id === saved.id ? context.active : undefined
  const task = active ?? saved
  const unfinished = task.execution === 'running' || task.execution === 'stopping'
  const state = unfinished && active === undefined ? 'unknown' : task.execution
  const interaction = state === 'running' ? context.interaction : undefined
  const execution = interaction !== undefined
    ? interaction === 'approval' ? '等待审批' : '等待回答'
    : {
      running: '执行中', stopping: '正在停止', completed: '完成', failed: '失败', cancelled: '已取消',
      unknown: '未知（请在 DSH 核对后再重试）',
    }[state]
  const delivery = task.delivery === 'pending' && !context.pendingTaskIds.has(task.id)
    ? '未知（请在 DSH 核对发送记录）'
    : {
      none: '尚无结果', sending: '发送中', sent: '已发送',
      pending: task.filesUnsent ? '文字待重发（附件可在 DSH 取回）' : '待重发',
      unknown: '未获平台确认', failed: '发送失败（可在 DSH 查看结果）',
    }[task.delivery]
  return { execution, delivery }
}

export function taskHistoryText(tasks: TaskRecord[], context: TaskMessageContext): string {
  if (tasks.length === 0) return chatParagraphs('【最近任务】', '暂无任务记录。')
  const rows = tasks.map((task) => {
    const { execution, delivery } = taskLabels(task, context)
    return `#${task.id.slice(0, 8)}｜${preview(task.summary, 28)}　｜　${execution} · ${delivery}`
  })
  return chatParagraphs('【最近任务】', ...rows)
}

export function taskStatusText({
  channel, latest, queued, pending, promptSending, recent, context,
}: {
  channel: string
  latest: TaskRecord | undefined
  queued: number
  pending: number
  promptSending: boolean
  recent: ReturnType<Journal['outbound']>
  context: TaskMessageContext
}): string {
  const paragraphs = [`【任务状态 · ${channel}】`]
  const task = context.active ?? latest
  if (task !== undefined) {
    const { execution, delivery } = taskLabels(task, context)
    const seconds = Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.startedAt) / 1000))
    paragraphs.push(
      `${context.active === undefined ? '最近任务' : '当前任务'}：${preview(task.summary, 42)}`,
      `执行状态：${execution}　｜　已用时：${seconds} 秒`,
      `结果发送：${delivery}`,
    )
  } else paragraphs.push('当前任务：无')

  paragraphs.push(`【队列】排队：${queued} 条　｜　待重发：${pending} 条`)
  if (promptSending) paragraphs.push('提示发送中')
  if (recent.length > 0) {
    paragraphs.push('【最近结果】')
    const labels = { accepted: '已发送', unconfirmed: '未确认', failed: '发送失败', pending: '投递未知' }
    const previews = new Map<string, number>()
    for (const entry of recent.slice(-2).reverse()) {
      const line = `${labels[entry.state]}｜${preview(entry.text, 28) || '附件'}`
      previews.set(line, (previews.get(line) ?? 0) + 1)
    }
    for (const [line, count] of previews) {
      paragraphs.push(count > 1 ? `· ${line}（${count} 条）` : `· ${line}`)
    }
  }
  return chatParagraphs(...paragraphs)
}

function preview(text: string, limit: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '))
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('')
}
