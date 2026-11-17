/**
 * The `approval/request` half: a tool wants to run, the person decides on their
 * phone, and the seam gets one of its four outcomes.
 *
 * The four are the host's: `allowed-once`, `rejected`, `cancelled`,
 * `unavailable`. "allowed-once" is the only allow there is — this plugin never
 * grants a standing permission from a chat message, because the next request
 * has no context to prove who approved it.
 *
 * The desktop's `unavailable` is NOT a decision: it means "nobody answered
 * here", so it never ends the wait while the chat still has the prompt on
 * screen. Two real decisions race; the first one wins.
 *
 * @module @rodin/dsh-channels/interaction/approval
 */
import type { InteractionEntry, InteractionQueue } from './queue.js'
import type { Target } from '../types.js'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

const ALLOW_TOKENS = new Set(['1', '允许', '同意', '批准', 'allow', 'yes', 'y', 'ok', '可以', '好'])
const DENY_TOKENS = new Set(['2', '拒绝', '不同意', 'deny', 'no', 'n', '不行', '不要'])
const CANCEL_TOKENS = new Set(['3', '取消', 'cancel', '算了'])

/** The prompt: what wants to run, why, and the two numbers that decide it. */
export function formatApprovalPrompt(request: { toolName?: string; reason?: string; displayReason?: unknown }): string {
  const tool = typeof request.toolName === 'string' && request.toolName !== '' ? request.toolName : '一个工具'
  const reason = typeof request.reason === 'string' && request.reason.trim() !== '' ? request.reason.trim() : ''
  const display = typeof request.displayReason === 'string' ? request.displayReason.trim() : ''
  const lines = ['【需要批准】', `${tool} 想要执行。`]
  if (reason !== '') lines.push(reason.length > 700 ? `${reason.slice(0, 700)}…` : reason)
  else if (display !== '') lines.push(display.length > 700 ? `${display.slice(0, 700)}…` : display)
  return lines.join('\n')
}

/** Reply text → one of the seam's outcomes; `null` means "not an answer". */
export function parseApprovalOutcome(text: string): ApprovalOutcome | null {
  const raw = String(text ?? '').trim().toLowerCase()
  if (raw === '') return null
  if (ALLOW_TOKENS.has(raw)) return 'allowed-once'
  if (DENY_TOKENS.has(raw)) return 'rejected'
  if (CANCEL_TOKENS.has(raw)) return 'cancelled'
  return null
}

export function approvalEntry({ target, request }: { target: Target; request: { toolName?: string; reason?: string; displayReason?: unknown } }): InteractionEntry {
  return {
    kind: 'approval',
    target,
    view: {
      title: formatApprovalPrompt(request),
      options: [
        { id: 'allowed-once', label: '允许（只这一次）' },
        { id: 'rejected', label: '拒绝' },
      ],
      hint: '回复 1 允许、2 拒绝；回复「取消」表示这次不处理。',
    },
    parse(text: string) {
      const outcome = parseApprovalOutcome(text)
      return outcome === null ? { ok: false, hint: '回复 1 允许、2 拒绝；回复「取消」结束这次请求。' } : { ok: true, value: outcome }
    },
    expiredNotice: '（这个审批等太久了，先在电脑上处理一下吧。）',
    retiredNotice: '（这个审批已经在电脑上处理过了。）',
    retireValue: 'unavailable',
  }
}

/**
 * The `approval/request` listener body.
 *
 * Runs both surfaces at once. `next()` resolves `'unavailable'` when no other
 * answerer decides, so that value alone does not settle anything.
 */
export async function answerApproval({
  queue,
  target,
  request,
  next,
  enabled = true,
  logger = { info: () => {}, warn: () => {} },
}: {
  queue: InteractionQueue
  target: Target | undefined
  request: { toolName?: string; reason?: string; displayReason?: unknown; signal?: AbortSignal }
  next: () => Promise<unknown>
  enabled?: boolean
  logger?: { info: (line: string) => void; warn: (line: string) => void }
}): Promise<unknown> {
  if (enabled !== true || target === undefined) return next()
  const entry = approvalEntry({ target, request })
  const remote = queue
    .ask(entry, { ...(request.signal === undefined ? {} : { signal: request.signal }) })
    .then((value) => ({ side: 'remote' as const, ok: true as const, value: value as ApprovalOutcome }), (error: unknown) => ({ side: 'remote' as const, ok: false as const, error }))
  const local = Promise.resolve()
    .then(() => next())
    .then((value) => ({ side: 'local' as const, ok: true as const, value: value as ApprovalOutcome }), (error: unknown) => ({ side: 'local' as const, ok: false as const, error }))

  // A decision is anything except "unavailable" — that one only means "nobody
  // answered here", and the chat may still answer. So this waits for the first
  // real decision, or for both surfaces to finish without one.
  const decision = await new Promise<{ side: 'remote' | 'local'; value: ApprovalOutcome } | undefined>((resolve) => {
    let settled = false
    let finished = 0
    const settle = (value: { side: 'remote' | 'local'; value: ApprovalOutcome } | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const finishOne = (): void => {
      finished += 1
      if (finished === 2) settle(undefined)
    }
    for (const [side, pending] of [['remote', remote], ['local', local]] as const) {
      void pending.then((result) => {
        if (result.ok === true && result.value !== 'unavailable') settle({ side, value: result.value })
      }).finally(finishOne)
    }
  })
  if (decision !== undefined) {
    if (decision.side === 'local') queue.retire(entry)
    return decision.value
  }

  // Nobody decided. An approval fails CLOSED, and the seam already has the word
  // for it: `unavailable`. Throwing here would make the host read a timeout as a
  // crashed answerer instead of "nobody said yes".
  const [remoteResult, localResult] = await Promise.all([remote, local])
  for (const result of [remoteResult, localResult]) {
    if (result.ok === false) logger.info?.(`approval surface ended without a decision: ${String((result.error as Error)?.message ?? result.error)}`)
  }
  return 'unavailable'
}
