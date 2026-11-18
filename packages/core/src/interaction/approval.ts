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
 * @module @derekluo/dsh-channels/interaction/approval
 */
import { withinLifetime } from './lifetime.js'
import type { InteractionEntry, InteractionQueue } from './queue.js'
import { randomBytes } from 'node:crypto'
import type { Target } from '../types.js'
import { chatParagraphs } from '../outbound.js'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

const ALLOW_TOKENS = new Set(['1', '允许', '同意', '批准', 'allow', 'yes', 'y', 'ok', '可以', '好'])
const DENY_TOKENS = new Set(['2', '拒绝', '不同意', 'deny', 'no', 'n', '不行', '不要'])
const CANCEL_TOKENS = new Set(['3', '取消', 'cancel', '算了'])

/** The prompt: identify the tool and show why it needs approval. */
export function formatApprovalPrompt(request: { toolName?: string; reason?: string; displayReason?: unknown }): string {
  const tool = typeof request.toolName === 'string' && request.toolName !== '' ? request.toolName : '一个工具'
  const reason = typeof request.reason === 'string' && request.reason.trim() !== '' ? request.reason.trim() : ''
  const display = typeof request.displayReason === 'string' ? request.displayReason.trim() : ''
  const detail = reason || display
  return chatParagraphs('【需要批准】', `工具：${tool}`, detail ? `原因：${detail.length > 700 ? detail.slice(0, 700) + '…' : detail}` : '')
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

export function isApprovalReply(text: string): boolean {
  const match = /^[a-f0-9]{6}\s+(\S+)$/i.exec(text.trim())
  return match?.[1] !== undefined && parseApprovalOutcome(match[1]) !== null
}

export function approvalEntry({ target, request }: { target: Target; request: { toolName?: string; reason?: string; displayReason?: unknown } }): InteractionEntry {
  const code = randomBytes(3).toString('hex')
  const hint = chatParagraphs('请回复下面任意一组验证码和序号。', `「${code} 1」允许一次`, `「${code} 2」拒绝`, `「${code} 3」取消审批`)
  return {
    kind: 'approval',
    target,
    view: {
      title: formatApprovalPrompt(request),
      options: [],
      hint,
      actions: [
        { label: '允许一次', value: `${code} 1` },
        { label: '拒绝', value: `${code} 2` },
        { label: '取消审批', value: `${code} 3` },
      ],
    },
    parse(text: string) {
      const parts = text.trim().split(/\s+/)
      const outcome = parts.length === 2 && parts[0]?.toLowerCase() === code ? parseApprovalOutcome(parts[1]!) : null
      return outcome === null ? { ok: false, hint } : { ok: true, value: outcome }
    },
    expiredNotice: '聊天审批已超时。请在 DSH 查看工具是否仍在等待批准。',
    retiredNotice: '审批已在 DSH 处理。',
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
  request: { toolName?: string; reason?: string; displayReason?: unknown; signal?: AbortSignal; deadlineAt?: number }
  next: () => Promise<unknown>
  enabled?: boolean
  logger?: { info: (line: string) => void; warn: (line: string) => void }
}): Promise<unknown> {
  if (enabled !== true || target === undefined) return next()
  const entry = approvalEntry({ target, request })
  const remote = queue
    .ask(entry, { signal: request.signal, deadlineAt: request.deadlineAt })
    .then((value) => ({ side: 'remote' as const, ok: true as const, value: value as ApprovalOutcome }), (error: unknown) => ({ side: 'remote' as const, ok: false as const, error }))
  const local = Promise.resolve()
    .then(() => next())
    .then((value) => ({ side: 'local' as const, ok: true as const, value: value as ApprovalOutcome }), (error: unknown) => ({ side: 'local' as const, ok: false as const, error }))

  // A decision is anything except "unavailable" — that one only means "nobody
  // answered here", and the chat may still answer. So this waits for the first
  // real decision, or for both surfaces to finish without one.
  const decision = await withinLifetime(new Promise<{ side: 'remote' | 'local'; value: ApprovalOutcome } | undefined>((resolve) => {
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
        // An expired or withdrawn chat prompt is a terminal "nobody answered
        // here" even if the desktop surface is still hanging.
        else if (side === 'remote' && result.ok === false) settle(undefined)
      }).finally(finishOne)
    }
  }), request.signal).catch((error: unknown) => {
    if (request.signal?.aborted) return undefined
    throw error
  })
  if (request.signal?.aborted) return 'unavailable'
  if (decision !== undefined) {
    if (decision.side === 'local') queue.retire(entry)
    return decision.value
  }

  // Nobody decided. An approval fails CLOSED, and the seam already has the word
  // for it: `unavailable`. Throwing here would make the host read a timeout as a
  // crashed answerer instead of "nobody said yes".
  const remoteResult = await remote
  if (remoteResult.ok === false) {
    // The chat prompt expired or was withdrawn. A hung desktop answerer must
    // not keep this seam open; the action fails closed.
    logger.info?.(`approval chat surface ended without a decision: ${String((remoteResult.error as Error)?.message ?? remoteResult.error)}`)
    return 'unavailable'
  }
  const localResult = await local
  if (localResult.ok === false) {
    logger.info?.(`approval desktop surface ended without a decision: ${String((localResult.error as Error)?.message ?? localResult.error)}`)
  }
  return 'unavailable'
}
