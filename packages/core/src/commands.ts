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
import type { InboundMessage } from './types.js'

export type CommandName = 'help' | 'status' | 'whoami' | 'new' | 'cancel' | 'clear'

export const TASK_CONTROLS: ReadonlySet<CommandName> = new Set(['status', 'cancel', 'clear'])

export const COMMANDS: Record<CommandName, { usage: string; summary: { en: string; zh: string } }> = {
  cancel: { usage: '/cancel', summary: { en: 'stop the current task', zh: '停止当前任务，保留排队消息' } },
  clear: { usage: '/clear', summary: { en: 'clear your queued messages', zh: '清除自己的排队消息' } },
  help: { usage: '/help', summary: { en: 'list the commands', zh: '列出可用命令' } },
  status: { usage: '/status', summary: { en: 'current task, execution, delivery and queues', zh: '当前任务、执行与投递状态、排队情况' } },
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
  if (!Object.hasOwn(COMMANDS, bare)) return null
  return { name: bare as CommandName, args: rest.join(' ').trim() }
}

/** The `/help` text, one line per command. */
export function helpText(): string {
  const lines = ['可用命令：']
  for (const [name, entry] of Object.entries(COMMANDS)) {
    lines.push(`/${name} — ${entry.summary.zh}`)
  }
  lines.push('', '直接发消息就是和 agent 对话。')
  return lines.join('\n')
}
