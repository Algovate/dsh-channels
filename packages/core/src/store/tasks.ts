/** Recent executions per chat; never replay this file as work. */
import { parseCommand } from '../commands.js'
import { sameTarget } from '../ids.js'
import type { InboundMessage, Target } from '../types.js'
import type { TurnBinding, RecoveryCursor } from '../turn-recovery.js'
import type { OutboxEntry, OutboxFile } from './outbox.js'
import { stateFile, type StateFile } from './state.js'
import { conforms, tasksSchema } from './schema.js'

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
  workingDirectory?: string
  project?: string
  replyMessage?: InboundMessage
  outputDirectory?: string
  artifacts?: string[]
  artifactsIncomplete?: boolean
  recovery?: TurnBinding & { message: InboundMessage; project?: string; cursor?: RecoveryCursor }
}
export class Tasks {
  readonly #store: StateFile
  readonly #warn: (line: string) => void
  #items: TaskRecord[] = []
  #unreadable = false
  constructor(root: string, warn: (line: string) => void) {
    this.#store = stateFile(root, warn)
    this.#warn = warn
    try {
      const data: unknown = this.#store.read<unknown>('tasks')
      if (data === undefined) return
      if (!conforms(tasksSchema, data)) throw new Error('invalid task records')
      this.#items = (data as TaskRecord[]).filter((task) => !isLegacyQuery(task)).map((task) => ({ ...task,
        execution: task.execution === 'running' || task.execution === 'stopping' ? 'unknown' : task.execution,
        delivery: task.delivery === 'sending' ? 'unknown' : task.delivery,
      }))
    } catch (error) {
      this.#unreadable = true; warn(`tasks could not be loaded: ${String(error)}`)
    }
  }
  latest(target: Target): TaskRecord | undefined {
    return this.#items.findLast((task) => sameTarget(task.target, target))
  }
  get(target: Target, id: string): TaskRecord | undefined {
    return this.#items.find((task) => task.id === id && sameTarget(task.target, target))
  }
  forTarget(target: Target, senderId?: string): TaskRecord[] {
    return this.#items.filter((task) => sameTarget(task.target, target) && (senderId === undefined || task.senderId === senderId))
  }
  recent(target: Target, senderId?: string): TaskRecord[] {
    return this.forTarget(target, senderId)
      .slice(-5)
      .reverse()
  }
  recoverable(): TaskRecord[] { return this.#items.filter((task) => task.recovery !== undefined) }

  /** Move result ownership from host-log recovery to durable delivery in one commit. */
  handoffDelivery(target: Target, id: string, outbox: OutboxFile, completion: Partial<TaskRecord> = {}): boolean {
    if (this.#unreadable) return false
    const task = this.get(target, id)
    if (!task) return false
    const items = this.#items.map((item) => item === task ? {
      ...item, ...completion, project: item.project ?? item.recovery?.project,
      replyMessage: item.replyMessage ?? item.recovery?.message,
      recovery: undefined, delivery: 'pending' as const,
    } : item)
    if (!this.#store.writeMany({ tasks: items, outbox })) return false
    this.#items = items
    return true
  }

  /** A final receipt and removal of its retry entry are one durable fact. */
  recordDelivery(outbox: OutboxFile, entry: OutboxEntry, result: { ok: boolean; unconfirmed?: boolean }, finished: boolean): boolean {
    const task = entry.taskId === undefined ? undefined : this.get(entry.target, entry.taskId)
    if (task === undefined) return this.#store.write('outbox', outbox)
    if (this.#unreadable) return false
    const unconfirmed = task.unconfirmed === true || entry.unconfirmed === true || result.unconfirmed === true
    const filesUnsent = entry.includesArtifacts
      ? task.artifactsIncomplete === true || entry.filesFailed === true || (!finished && (entry.outgoing.artifact !== undefined || (entry.attachments?.length ?? 0) > 0))
      : task.filesUnsent
    const delivery = !finished ? 'pending' : filesUnsent ? 'failed' : unconfirmed || task.delivery === 'unknown' ? 'unknown' : 'sent'
    const items = this.#items.map((item) => item === task ? { ...item, unconfirmed, filesUnsent, delivery } as TaskRecord : item)
    if (!this.#store.writeMany({ tasks: items, outbox })) return false
    this.#items = items
    return true
  }
  save(task: TaskRecord): boolean {
    // The inbox may still contain this ID if the process stopped between the two writes.
    const previous = this.#items.filter((item) => item.id !== task.id || !sameTarget(item.target, task.target))
    const chatTasks = previous.filter((item) => sameTarget(item.target, task.target))
    const overflow = Math.max(0, chatTasks.length + 1 - MAX_TASKS_PER_CHAT)
    const evictable = (item: TaskRecord) => item.recovery === undefined && item.execution !== 'running' && item.execution !== 'stopping'
      && item.delivery !== 'pending' && item.delivery !== 'sending'
    const evicted = new Set(chatTasks.filter(evictable).slice(0, overflow))
    const retained = previous.filter((item) => !evicted.has(item))
    const globalOverflow = Math.max(0, retained.length + 1 - MAX_TASKS)
    const globalEvictions = new Set(retained.filter(evictable).slice(0, globalOverflow))
    if (globalEvictions.size < globalOverflow) return false
    return this.#write([...retained.filter((item) => !globalEvictions.has(item)), task])
  }
  #write(items: TaskRecord[]): boolean {
    if (this.#unreadable || !this.#store.write('tasks', items)) return false
    this.#items = items
    return true
  }
  update(target: Target, id: string, patch: Partial<Pick<TaskRecord, 'execution' | 'delivery' | 'endedAt' | 'unconfirmed' | 'filesUnsent' | 'outputDirectory' | 'artifacts' | 'artifactsIncomplete' | 'recovery'>>): boolean {
    const index = this.#items.findIndex((item) => item.id === id && sameTarget(item.target, target))
    const task = this.#items[index]
    if (task === undefined) return false
    const items = this.#items.slice()
    items[index] = { ...task, ...patch }
    if (!this.#write(items)) {
      this.#items[index] = { ...task, execution: 'unknown', delivery: 'unknown' }
      this.#warn('task status could not be saved')
      return false
    }
    return true
  }
}

// Releases before /tasks could execute a bare query as an ordinary message.
function isLegacyQuery(task: TaskRecord): boolean {
  const command = parseCommand(task.summary)
  return command?.name === 'tasks' && command.args === ''
}
