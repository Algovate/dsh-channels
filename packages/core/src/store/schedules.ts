/** Native execution stays in DSH; this file owns only channel attribution and result handoff. */
import { stateFile, type StateFile } from './state.js'
import { bindingInvariants, conforms, scheduleStateInvariants, scheduleStateSchema } from './schema.js'
import type { InboundMessage } from '../types.js'
import type { TurnProgressSnapshot } from '../turn-progress.js'

export interface ScheduleBinding {
  id: string; sessionId: string; scheduleId?: string; title: string
  message: InboundMessage; project: string; workingDirectory: string; createdAt: number; deleting?: boolean
  cursor: number; handled: string[]; progress?: TurnProgressSnapshot
}
export interface ScheduleNotification { id: string; bindingId: string; text: string }
export interface ScheduleState { version: 1; bindings: ScheduleBinding[]; pending: ScheduleNotification[] }
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
      if (!conforms(scheduleStateSchema, saved) || !scheduleStateInvariants(saved as ScheduleState) || !(saved as ScheduleState).bindings.every(bindingInvariants)) throw new Error('invalid schedule state')
      this.#state = saved as ScheduleState
    } catch (error) {
      this.#unreadable = true; warn('channel schedule state is unreadable; owned schedule activation is blocked')
    }
  }
  read(): ScheduleState {
    if (this.#unreadable) throw new Error('计划状态不可读，请修复 state.json 的 schedules 段后重启')
    return structuredClone(this.#state)
  }
  save(state: ScheduleState): void {
    if (this.#unreadable || !conforms(scheduleStateSchema, state) || !scheduleStateInvariants(state) || !state.bindings.every(bindingInvariants) || !this.#store.write('schedules', state)) throw new Error('计划状态未能保存，请在 DSH 检查 state.json')
    this.#state = structuredClone(state)
  }
}
