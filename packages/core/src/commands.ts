/**
 * Slash commands a person types in the chat.
 *
 * A phone has no settings page, no session list and no way to start a fresh
 * conversation: without commands, the only way to reset a channel chat is to
 * edit files on the host. The commands cover discovery and task control:
 * `/help` (what exists), `/status` (is it healthy), `/whoami` (which id do I put
 * in the allowlist) and `/new` (start a clean session, keeping the old one).
 *
 * Commands are consumed after the gates and before the turn queue: an allowed
 * sender gets an answer, a stranger gets the gate's refusal, and neither starts
 * a model turn. Task controls remain available after the turn quota runs out.
 *
 * @module @derekluo/dsh-channels/commands
 */
import { chatParagraphs } from './outbound.js'

export type CommandName = 'help' | 'status' | 'tasks' | 'whoami' | 'new' | 'cancel' | 'clear' | 'files' | 'resend' | 'projects' | 'project' | 'sessions' | 'session' | 'schedule' | 'schedules'

export const TASK_CONTROLS: ReadonlySet<CommandName> = new Set(['schedule', 'schedules', 'projects', 'project', 'sessions', 'session', 'status', 'tasks', 'cancel', 'clear', 'files', 'resend'])

export const COMMANDS: Record<Exclude<CommandName, 'sessions' | 'session'>, { usage: string; summary: { en: string; zh: string } }> = {
  schedules: { usage: '/schedules', summary: { en: 'list your channel schedules', zh: '查看你在此聊天创建的计划' } },
  schedule: { usage: '/schedule after|every <分钟> <任务>', summary: { en: 'create a native schedule; pause/resume/delete by id', zh: '创建计划；也可 pause/resume/delete <计划ID>' } },
  projects: { usage: '/projects', summary: { en: 'list configured projects', zh: '查看可用项目' } },
  project: { usage: '/project <别名>', summary: { en: 'switch project', zh: '切换后续消息的项目' } },
  status: { usage: '/status', summary: { en: 'current task, execution, delivery and queues', zh: '查看任务、排队和发送状态' } },
  tasks: { usage: '/tasks', summary: { en: 'list recent tasks', zh: '查看最近 5 项任务' } },
  files: { usage: '/files [任务ID]', summary: { en: 'list recorded task artifacts', zh: '查看已完成任务的产物' } },
  resend: { usage: '/resend <任务ID> [序号]', summary: { en: 'resend one task artifact', zh: '重新发送任务产物，默认第 1 个' } },
  cancel: { usage: '/cancel', summary: { en: 'stop the current task', zh: '停止当前任务，保留排队消息' } },
  clear: { usage: '/clear', summary: { en: 'clear your queued messages', zh: '清除自己的排队消息' } },
  help: { usage: '/help', summary: { en: 'list the commands', zh: '列出可用命令' } },
  whoami: { usage: '/whoami', summary: { en: 'your sender id and this conversation', zh: '你的发送者 id 和当前会话' } },
  new: { usage: '/new', summary: { en: 'start a fresh session here', zh: '在这里开一个新会话' } },
}

/** `"/status"` → `{ name: 'status', args: '' }`; anything else → null. */
export function parseCommand(text: string): { name: CommandName; args: string } | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = (rawName ?? '').toLowerCase()
  // Telegram appends `@botname` to commands in groups.
  const bare = name.includes('@') ? name.slice(0, name.indexOf('@')) : name
  // Retired controls stay out of help and must never become model input.
  if (bare !== 'sessions' && bare !== 'session' && !Object.hasOwn(COMMANDS, bare)) return null
  return { name: bare as CommandName, args: rest.join(' ').trim() }
}

/** The `/help` text, one line per command. */
export function helpText(): string {
  return chatParagraphs(
    '【可用命令】',
    ...Object.values(COMMANDS).map(({ usage, summary }) => `${usage}　｜　${summary.zh}`),
    '直接发消息即可交给助手处理。',
  )
}
