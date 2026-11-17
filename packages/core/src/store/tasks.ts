/** Latest execution per chat; never replay this file as work. */
import fs from 'node:fs'
import { sameTarget } from '../ids.js'
import type { Target } from '../types.js'
import { atomicWriteJson } from './atomic.js'
import { statePath } from './layout.js'

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
  latest(target: Target): TaskRecord | undefined { return this.#items.find((task) => sameTarget(task.target, target)) }
  save(task: TaskRecord): boolean {
    const items = [...this.#items.filter((item) => !sameTarget(item.target, task.target)), task].slice(-500)
    if (this.#unreadable || !atomicWriteJson(this.#file, items, { warn: this.#warn })) return false
    this.#items = items
    return true
  }
  update(target: Target, id: string, patch: Partial<Pick<TaskRecord, 'execution' | 'delivery' | 'endedAt' | 'unconfirmed' | 'filesUnsent'>>): void {
    const task = this.latest(target)
    if (task?.id === id && !this.save({ ...task, ...patch })) {
      this.#items = this.#items.map((item) => item.id === id ? { ...item, execution: 'unknown', delivery: 'unknown' } : item)
      this.#warn('task status could not be saved')
    }
  }
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
