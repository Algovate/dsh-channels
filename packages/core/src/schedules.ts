/** Native schedules execute in DSH; the bridge owns attribution, management scope and text relay. */
import { readSessionEvents, type SessionPersistence } from './session-reader.js'
import { randomUUID } from 'node:crypto'
import { ChannelSchedulesStore, type ScheduleBinding } from './store/schedules.js'
import { createHostPort, type HostContext, type HostPort } from './host.js'
import { TurnProgress } from './turn-progress.js'
import { sameTarget } from './ids.js'
import { chatParagraphs } from './outbound.js'
import type { InboundMessage, SendResult, Target } from './types.js'

interface NativeTask { id: string; target: { kind: string; sessionId?: string }; status: string; updatedAt?: string }
interface NativeSchedule {
  create(request: unknown, actor?: string, signal?: AbortSignal): Promise<NativeTask>
  catalog(): NativeTask[] | Promise<NativeTask[]>
  edit(request: unknown, actor?: string, signal?: AbortSignal): Promise<unknown>
  history(request: unknown): Promise<{ records?: Array<{ messageId: string; targetSessionId: string }>; nextBefore?: string }>
}
interface Options {
  ctx: HostContext
  stateRoot: string
  logger: { warn(line: string): void }
  route(message: InboundMessage): { workingDirectory: string; project: string }
  attach(message: InboundMessage, sessionId: string, workingDirectory: string): Promise<void>
  canManage(message: InboundMessage): Promise<boolean>
  authorized(binding: ScheduleBinding): Promise<boolean>
  send(message: InboundMessage, text: string, deliveryId?: string): Promise<readonly SendResult[]>
  queued(deliveryId: string): boolean
}
const PREFIX = 'chan-schedule-'
export class ChannelSchedules {
  readonly #options: Options
  readonly #host: HostPort
  readonly #store: ChannelSchedulesStore
  readonly #stop = new AbortController()
  readonly #offs: Array<() => void> = []
  #activationRegistered = false
  #chain: Promise<unknown> = Promise.resolve()
  #syncing: Promise<void> | undefined
  constructor(options: Options) {
    this.#options = options
    this.#host = createHostPort(options.ctx)
    this.#store = new ChannelSchedulesStore(options.stateRoot, options.logger.warn)
    try {
      if (this.#host.hasEventBus()) {
        const off = this.#host.on('schedule/resolve-agent', ((id: string, next: () => Promise<unknown>) => this.#guard(id, next)) as never, { prepend: true, global: true })
        this.#offs.push(off)
        this.#activationRegistered = true
        const events = this.#host.on('session/event', ((session: { id?: string }, event: { type?: string }) => {
          if (session?.id?.startsWith(PREFIX) && event?.type === 'turn/end') void this.sync().catch((error) => options.logger.warn(String(error)))
        }) as never, { global: true })
        this.#offs.push(events)
      }
    } catch (error) { options.logger.warn(`schedule hooks unavailable: ${String(error)}`) }
  }
  #services(): { native: NativeSchedule; persistence: SessionPersistence } {
    const native = this.#host.get<NativeSchedule>('schedule')
    const persistence = this.#host.get<SessionPersistence>('sessionPersistence')
    if (!this.#activationRegistered || typeof native?.create !== 'function' || typeof native.catalog !== 'function' || typeof native.edit !== 'function' || typeof native.history !== 'function' || typeof persistence?.open !== 'function') throw new Error('宿主未启用兼容的 DSH 计划任务及会话持久化服务，当前不可用。')
    return { native, persistence }
  }
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.catch(() => {}).then(async () => { this.#stop.signal.throwIfAborted(); return work() })
    this.#chain = next.catch(() => {})
    return next
  }
  async #guard(id: string, next: () => Promise<unknown>): Promise<unknown> {
    if (!id.startsWith(PREFIX)) return next()
    this.#stop.signal.throwIfAborted()
    const binding = this.#store.read().bindings.find((item) => item.sessionId === id)
    if (!binding || binding.deleting || !binding.scheduleId || !await this.#options.authorized(binding)) throw new Error('通道计划的归属、权限或原项目不可用，禁止激活')
    const task = (await this.#services().native.catalog()).find((item) => item.id === binding.scheduleId)
    this.#stop.signal.throwIfAborted()
    if (!this.#matches(binding, task)) throw new Error('通道计划的原生目标已改变，禁止激活')
    if (!await this.#options.authorized(binding)) throw new Error('通道计划权限已改变，禁止激活')
    this.#stop.signal.throwIfAborted()
    if (!this.#current(binding)) throw new Error('通道计划绑定已删除或改变，禁止激活')
    return next()
  }
  #current(binding: ScheduleBinding): boolean {
    return this.#store.read().bindings.some((item) => item.id === binding.id && !item.deleting && item.scheduleId === binding.scheduleId)
  }
  #matches(binding: ScheduleBinding, task?: NativeTask): task is NativeTask {
    return task !== undefined && task.target?.kind === 'session' && task.target.sessionId === binding.sessionId
  }
  async canDeliver(deliveryId: string, target: Target): Promise<boolean> {
    this.#stop.signal.throwIfAborted()
    const id = /^schedule:([a-f0-9-]{36}):.+$/.exec(deliveryId)?.[1]
    const binding = this.#store.read().bindings.find((item) => item.id === id)
    if (!binding || binding.deleting || !sameTarget(binding.message, target)) return false
    const allowed = await this.#options.authorized(binding)
    this.#stop.signal.throwIfAborted()
    if (!allowed) return false
    const task = (await this.#services().native.catalog()).find((item) => item.id === binding.scheduleId)
    this.#stop.signal.throwIfAborted()
    if (!this.#matches(binding, task)) return false
    const stillAllowed = await this.#options.authorized(binding)
    this.#stop.signal.throwIfAborted()
    return stillAllowed && this.#current(binding)
  }
  #visible(binding: ScheduleBinding, message: InboundMessage): boolean {
    return sameTarget(binding.message, message) && binding.message.senderId === message.senderId
  }
  async command(message: InboundMessage, name: 'schedule' | 'schedules', args: string): Promise<void> {
    return this.#exclusive(async () => {
      const notice = (text: string) => this.#options.send(message, text)
      try {
        const requireManagement = async () => {
          this.#stop.signal.throwIfAborted()
          if (!await this.#options.canManage(message)) throw new Error('当前发送者或账号权限已失效，未执行计划操作')
          this.#stop.signal.throwIfAborted()
        }
        await requireManagement()
        const { native } = this.#services()
        if (name === 'schedule' && /^(after|every)\s/.test(args)) {
          const match = /^(after|every)\s+([1-9]\d{0,5})\s+([\s\S]+)$/.exec(args)
          if (!match || Number(match[2]) > 525600 || match[3]!.trim().length > 4000) { await notice('用法：/schedule after|every <1–525600 分钟> <不超过 4000 字的任务>。'); return }
          if (message.media.length || message.attachmentErrors?.length) { await notice('计划命令暂不接收附件，请把任务写完整并引用项目内已存在的文件。'); return }
          const state = this.#store.read()
          if (state.bindings.length >= 100 || state.bindings.filter((item) => this.#visible(item, message)).length >= 20) { await notice('计划数量已达上限，请先删除不需要的计划。'); return }
          const id = randomUUID(); const route = this.#options.route(message); const prompt = match[3]!.trim()
          const binding: ScheduleBinding = {
            id, sessionId: PREFIX + id, title: Array.from(prompt).slice(0, 60).join(''), message: { channel: message.channel, accountId: message.accountId, conversationId: message.conversationId, senderId: message.senderId, text: prompt, group: message.group, at: message.at, media: [], raw: message.raw },
            workingDirectory: route.workingDirectory, project: route.project, createdAt: Date.now(), cursor: 0, handled: [],
          }
          state.bindings.push(binding); this.#store.save(state)
          await this.#options.attach(binding.message, binding.sessionId, binding.workingDirectory)
          await requireManagement()
          if (!await this.#options.authorized(binding)) throw new Error('原项目或账号权限已失效，未创建原生计划')
          this.#stop.signal.throwIfAborted()
          const created = await native.create({ title: binding.title, prompt, timing: match[1] === 'after' ? { kind: 'after', after_seconds: Number(match[2]) * 60 } : { kind: 'every', every_seconds: Number(match[2]) * 60 }, target: { kind: 'session', sessionId: binding.sessionId } }, binding.sessionId, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(30000)]))
          if (!this.#matches(binding, created) || typeof created.id !== 'string') throw new Error('原生创建结果尚未确认；请用 /schedules 查看，不要重复创建')
          binding.scheduleId = created.id; this.#store.save(state)
          await notice(`已创建计划 #${id.slice(0, 8)}：${binding.title}。${match[1] === 'after' ? `${match[2]} 分钟后执行一次` : `每 ${match[2]} 分钟执行`}，最终文字回到此聊天。`)
          return
        }
        await this.#recover(native)
        const state = this.#store.read(); const owned = state.bindings.filter((item) => this.#visible(item, message)); const tasks = await native.catalog()
        await requireManagement()
        if (name === 'schedules') {
          await notice(owned.length ? chatParagraphs('【本聊天的计划】', ...owned.map((binding) => {
            const task = tasks.find((item) => item.id === binding.scheduleId)
            const status = binding.deleting ? '删除待确认' : !binding.scheduleId ? '创建待确认' : !this.#matches(binding, task) ? '原生目标不可用' : task.status === 'active' ? '已启用' : task.status === 'paused' ? '已暂停' : '已结束'
            return `#${binding.id.slice(0, 8)}｜${binding.title}｜${status}`
          })) : '当前聊天中暂无你创建的计划。')
          return
        }
        const match = /^(pause|resume|delete)\s+([a-f0-9-]{8,36})$/.exec(args)
        if (!match) { await notice('用法：/schedule after|every <分钟> <任务>；/schedules；/schedule pause|resume|delete <计划ID>。'); return }
        const matches = owned.filter((item) => item.id.startsWith(match[2]!))
        if (matches.length !== 1) { await notice('未找到唯一的本聊天计划，请从 /schedules 复制计划ID。'); return }
        const binding = matches[0]!; const task = tasks.find((item) => item.id === binding.scheduleId)
        if (match[1] === 'delete') {
          binding.deleting = true; this.#store.save(state); await this.#recover(native)
          await notice(!binding.scheduleId ? '已取消本聊天绑定。原生创建结果尚未确认，请在 DSH 核对；迟到的原生执行将被此插件禁止激活。' : !this.#matches(binding, task) && task ? '已移除本聊天绑定；原生目标已改变，请在 DSH 管理。' : '已请求删除计划；已开始的原生回合不会被撤销。')
          return
        }
        if (!this.#matches(binding, task)) { await notice('原生计划目标不可用，请在 DSH 查看。'); return }
        const result = await native.edit({ id: task.id, action: 'update', patch: { active: match[1] === 'resume' }, expectedUpdatedAt: task.updatedAt ?? null }, binding.sessionId, this.#stop.signal) as { code?: string }
        await notice(result.code ? '原生计划已改变，请重新查看 /schedules 后再试。' : match[1] === 'resume' ? '计划已恢复。' : '计划已暂停；已开始的回合仍会继续。')
      } catch (error) { await notice(`计划操作未完成：${String((error as Error)?.message ?? error)}`) }
    })
  }
  async #recover(native: NativeSchedule): Promise<void> {
    const state = this.#store.read(); const tasks = await native.catalog(); let changed = false
    for (const binding of state.bindings) {
      if (!binding.scheduleId) {
        const matches = tasks.filter((task) => this.#matches(binding, task))
        if (matches.length === 1) { binding.scheduleId = matches[0]!.id; changed = true }
      }
      if (!binding.deleting) continue
      const task = tasks.find((item) => item.id === binding.scheduleId)
      if (this.#matches(binding, task)) {
        const result = await native.edit({ id: task.id, action: 'delete', expectedUpdatedAt: task.updatedAt ?? null }, binding.sessionId, this.#stop.signal) as { deleted?: boolean }
        if (!result.deleted) continue
      }
      state.bindings = state.bindings.filter((item) => item.id !== binding.id)
      state.pending = state.pending.filter((item) => item.bindingId !== binding.id); changed = true
    }
    if (changed) this.#store.save(state)
  }
  sync(): Promise<void> {
    if (this.#syncing) return this.#syncing
    const work = this.#exclusive(async () => {
      let services: { native: NativeSchedule; persistence: SessionPersistence }
      try { services = this.#services() } catch { return }
      await this.#recover(services.native)
      for (const binding of this.#store.read().bindings) {
        if (this.#stop.signal.aborted) return
        if (binding.deleting || !binding.scheduleId || !await this.#options.authorized(binding)) continue
        try { await this.#collect(binding, services.native, services.persistence) }
        catch (error) { this.#options.logger.warn(`schedule result read failed for ${binding.id}: ${String(error)}`) }
      }
      for (const notification of this.#store.read().pending) {
        const state = this.#store.read(); const binding = state.bindings.find((item) => item.id === notification.bindingId)
        if (!binding || binding.deleting) continue
        const deliveryId = `schedule:${notification.id}`
        if (!await this.canDeliver(deliveryId, binding.message)) continue
        let accepted = this.#options.queued(deliveryId)
        if (!accepted) {
          const results = await this.#options.send(binding.message, notification.text, deliveryId)
          accepted = (results.length > 0 && results.every((result) => result.ok)) || this.#options.queued(deliveryId)
        }
        if (accepted) { state.pending = state.pending.filter((item) => item.id !== notification.id); this.#store.save(state) }
      }
    })
    this.#syncing = work
    void work.finally(() => { if (this.#syncing === work) this.#syncing = undefined }).catch(() => {})
    return work
  }
  async #collect(binding: ScheduleBinding, native: NativeSchedule, persistence: SessionPersistence): Promise<void> {
    const task = (await native.catalog()).find((item) => item.id === binding.scheduleId)
    if (!this.#matches(binding, task)) return
    const receipts: Array<{ messageId: string; targetSessionId: string }> = []; let before: string | undefined
    for (let page = 0; page < 2; page++) {
      const history = await native.history({ id: task.id, limit: 100, before })
      receipts.push(...(history.records ?? [])); before = history.nextBefore
      if (!before) break
    }
    const receipt = receipts.slice().reverse().find((item) => item.targetSessionId === binding.sessionId && !binding.handled.includes(item.messageId))
    const messageId = binding.progress?.messageId ?? receipt?.messageId
    if (!messageId) return
    const state = this.#store.read()
    if (state.pending.filter((item) => item.bindingId === binding.id).length >= 10) return
    const progress = binding.progress ? TurnProgress.restore(binding.progress) : new TurnProgress(binding.cursor - 1, messageId)
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(10000)])
    for await (const event of readSessionEvents(persistence, binding.sessionId, binding.workingDirectory, progress.nextSeq, signal)) {
      progress.update([event])
      if (progress.result) break
    }
    if (progress.result) {
      const body = progress.result.failed ? '计划执行失败或已取消，请在 DSH 核对已经完成的操作。' : progress.result.text.slice(0, 16000) + (progress.result.text.length >= 16000 ? '\n（结果已截断，完整内容请在 DSH 查看。）' : '')
      state.pending.push({ id: `${binding.id}:${messageId}`, bindingId: binding.id, text: chatParagraphs(`【计划 #${binding.id.slice(0, 8)} · ${binding.title}】`, body || '计划已完成，没有可回传的文字。') })
      binding.handled = [...binding.handled, messageId].slice(-200); binding.cursor = progress.nextSeq; binding.progress = undefined
    } else binding.progress = progress.snapshot()
    state.bindings = state.bindings.map((item) => item.id === binding.id ? binding : item)
    this.#store.save(state)
  }
  dispose(): void {
    this.#stop.abort()
    for (const off of this.#offs.splice(0)) {
      try { off() } catch (error) { this.#options.logger.warn(`schedule hook cleanup failed: ${String(error)}`) }
    }
  }
}
