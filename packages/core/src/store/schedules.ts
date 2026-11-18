/** Native execution stays in DSH; this file owns only channel attribution and result handoff. */
import { stateFile, type StateFile } from './state.js'
import type { InboundMessage } from '../types.js'
import type { TurnProgressSnapshot } from '../turn-progress.js'

export interface ScheduleBinding {
  id: string; sessionId: string; scheduleId?: string; title: string
  message: InboundMessage; project: string; workingDirectory: string; createdAt: number; deleting?: boolean
  cursor: number; handled: string[]; progress?: TurnProgressSnapshot
}
export interface ScheduleNotification { id: string; bindingId: string; text: string }
export interface ScheduleState { version: 1; bindings: ScheduleBinding[]; pending: ScheduleNotification[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
function validBinding(value: unknown): value is ScheduleBinding {
  if (!object(value)) return false
  const item = value as unknown as ScheduleBinding; const message = item.message; const progress = item.progress
  return typeof item.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id)
    && item.sessionId === `chan-schedule-${item.id}` && (item.scheduleId === undefined || (typeof item.scheduleId === 'string' && item.scheduleId.length > 0))
    && ['title', 'project', 'workingDirectory'].every((key) => typeof value[key] === 'string') && item.title.length <= 120
    && integer(item.createdAt) && integer(item.cursor) && strings(item.handled) && item.handled.length <= 200
    && (item.deleting === undefined || typeof item.deleting === 'boolean')
    && object(message) && ['channel', 'accountId', 'conversationId', 'senderId', 'text'].every((key) => typeof message[key as keyof InboundMessage] === 'string')
    && typeof message.group === 'boolean' && Number.isFinite(message.at) && Array.isArray(message.media) && message.media.length === 0
    && (progress === undefined || (object(progress) && typeof progress.messageId === 'string' && Number.isSafeInteger(progress.lastSeq) && progress.lastSeq >= -1
      && ['activeTurn', 'matchingTurn', 'inboxIndex'].every((key) => progress[key as keyof TurnProgressSnapshot] === undefined || integer(progress[key as keyof TurnProgressSnapshot]))
      && typeof progress.text === 'string' && progress.text.length <= 16000 && typeof progress.cancelled === 'boolean'))
}
function validState(value: unknown): value is ScheduleState {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 100 || !value.bindings.every(validBinding) || !Array.isArray(value.pending) || value.pending.length > 1000) return false
  const bindings = value.bindings
  return new Set(bindings.map((item) => item.id)).size === bindings.length
    && value.pending.every((item) => object(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.length <= 17000 && bindings.some((owner) => owner.id === item.bindingId))
    && new Set(value.pending.map((item) => item.id)).size === value.pending.length
}
export class ChannelSchedulesStore {
  readonly #store: StateFile
  readonly #warn: (line: string) => void
  #state: ScheduleState = { version: 1, bindings: [], pending: [] }
  #unreadable = false
  constructor(root: string, warn: (line: string) => void) {
    this.#store = stateFile(root, warn); this.#warn = warn
    try {
      const saved: unknown = this.#store.read<unknown>('schedules')
      if (saved === undefined) return
      if (!validState(saved)) throw new Error('invalid schedule state')
      this.#state = saved
    } catch (error) {
      this.#unreadable = true; warn('channel schedule state is unreadable; owned schedule activation is blocked')
    }
  }
  read(): ScheduleState {
    if (this.#unreadable) throw new Error('计划状态不可读，请修复 schedules.json 后重启')
    return structuredClone(this.#state)
  }
  save(state: ScheduleState): void {
    if (this.#unreadable || !validState(state) || !this.#store.write('schedules', state)) throw new Error('计划状态未能保存，请在 DSH 检查 state.json')
    this.#state = structuredClone(state)
  }
}
