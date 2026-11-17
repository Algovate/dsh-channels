/** Recent executions per chat; never replay this file as work. */
import fs from 'node:fs'
import { parseCommand } from '../commands.js'
import { sameTarget } from '../ids.js'
import type { Target } from '../types.js'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'

const MAX_TASKS = 500
const MAX_TASKS_PER_CHAT = 10

export type ExecutionState = 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type DeliveryState = 'none' | 'sending' | 'sent' | 'pending' | 'unknown' | 'failed'
export interface TaskRecord {
  id: string
  target: Target
  senderId: string
  summary: string
  startedAt: number
  endedAt?: number
  execution: ExecutionState
  delivery: DeliveryState
  unconfirmed?: boolean
  filesUnsent?: boolean
}
export class Tasks {
  readonly #file: string
  readonly #warn: (line: string) => void
  #items: TaskRecord[] = []
  #unreadable = false
  constructor(root: string, warn: (line: string) => void) {
    this.#file = statePath(root, 'tasks')
    this.#warn = warn
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
      if (!Array.isArray(data) || !data.every(validTask)) throw new Error('invalid task records')
      this.#items = data.map((task) => ({ ...task,
        execution: task.execution === 'running' || task.execution === 'stopping' ? 'unknown' : task.execution,
        delivery: task.delivery === 'sending' ? 'unknown' : task.delivery,
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.#unreadable = true; warn(`tasks could not be loaded: ${String(error)}`) }
    }
  }
  latest(target: Target): TaskRecord | undefined {
    return this.#items.findLast((task) => sameTarget(task.target, target) && !isLegacyQuery(task))
  }
  get(target: Target, id: string): TaskRecord | undefined {
    return this.#items.find((task) => task.id === id && sameTarget(task.target, target))
  }
  recent(target: Target, senderId?: string): TaskRecord[] {
    return this.#items
      .filter((task) => sameTarget(task.target, target) && (senderId === undefined || task.senderId === senderId) && !isLegacyQuery(task))
      .slice(-5)
      .reverse()
  }
  save(task: TaskRecord): boolean {
    // The inbox may still contain this ID if the process stopped between the two writes.
    const previous = this.#items.filter((item) => item.id !== task.id || !sameTarget(item.target, task.target))
    const chatTasks = previous.filter((item) => sameTarget(item.target, task.target))
    const overflow = Math.max(0, chatTasks.length + 1 - MAX_TASKS_PER_CHAT)
    const evicted = new Set(chatTasks.slice(0, overflow))
    const retained = previous.filter((item) => !evicted.has(item))
    return this.#write([...retained, task].slice(-MAX_TASKS))
  }
  #write(items: TaskRecord[]): boolean {
    if (this.#unreadable || !atomicWriteJson(this.#file, items, { warn: this.#warn })) return false
    this.#items = items
    return true
  }
  update(target: Target, id: string, patch: Partial<Pick<TaskRecord, 'execution' | 'delivery' | 'endedAt' | 'unconfirmed' | 'filesUnsent'>>): void {
    const index = this.#items.findIndex((item) => item.id === id && sameTarget(item.target, target))
    const task = this.#items[index]
    if (task === undefined) return
    const items = this.#items.slice()
    items[index] = { ...task, ...patch }
    if (!this.#write(items)) {
      this.#items[index] = { ...task, execution: 'unknown', delivery: 'unknown' }
      this.#warn('task status could not be saved')
    }
  }
}

// Releases before /tasks could execute a bare query as an ordinary message.
function isLegacyQuery(task: TaskRecord): boolean {
  const command = parseCommand(task.summary)
  return command?.name === 'tasks' && command.args === ''
}

function validTask(value: unknown): value is TaskRecord {
  if (value === null || typeof value !== 'object') return false
  const task = value as Partial<TaskRecord>
  return typeof task.id === 'string' && typeof task.senderId === 'string' && typeof task.summary === 'string'
    && (task.unconfirmed === undefined || typeof task.unconfirmed === 'boolean')
    && (task.filesUnsent === undefined || typeof task.filesUnsent === 'boolean')
    && Number.isFinite(task.startedAt) && (task.endedAt === undefined || Number.isFinite(task.endedAt))
    && task.target !== null && typeof task.target === 'object'
    && ['channel', 'accountId', 'conversationId'].every((key) => typeof task.target![key as keyof Target] === 'string')
    && ['running', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'].includes(task.execution ?? '')
    && ['none', 'sending', 'sent', 'pending', 'unknown', 'failed'].includes(task.delivery ?? '')
}
