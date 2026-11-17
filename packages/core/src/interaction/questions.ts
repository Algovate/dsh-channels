/**
 * The `user-questions/request` half: one question (or a few) in the chat, one
 * reply turned back into the answer batch the seam expects.
 *
 * Vocabulary is the host's, not ours:
 *   `{ answers: [{ id, selected: string[], custom?: string }] }`
 *   `selected: []` with no `custom` means "skipped".
 *
 * Two rules come from the seam being one-shot:
 *  - both surfaces (the chat and the desktop) are asked at once and the first
 *    answer wins; a chat-only listener would blind the desktop while it waits;
 *  - an unparsable reply must not consume the question — the person gets a hint
 *    and keeps the prompt.
 *
 * @module @derekluo/dsh-channels/interaction/questions
 */
import { withinLifetime } from './lifetime.js'
import { interactionValidity, type InteractionEntry, type InteractionQueue } from './queue.js'
import { chatParagraphs } from '../outbound.js'
import type { Target } from '../types.js'

/** A plan or permission detail longer than this is cut with an ellipsis. */
const MAX_DETAIL_CHARS = 800
/** Words a person uses to decline to answer. */
const SKIP_TOKENS = new Set(['0', '跳过', '跳過', 'skip', 'pass', 'none', '不答'])

export interface AskUserQuestionItem {
  id?: string
  header?: string
  question?: string
  detail?: string
  options?: Array<{ label?: string; description?: string } | string>
  multiple?: boolean
}

export interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

/** The numbered prompt, including how to answer. */
export function formatQuestionPrompt(questions: readonly AskUserQuestionItem[], { waitMs }: { waitMs?: number } = {}): string {
  const list = Array.isArray(questions) ? questions : []
  const lines = ['【提问】']
  const several = list.length > 1
  list.forEach((question, index) => {
    if (several) lines.push(`第 ${index + 1} 题`)
    const header = typeof question?.header === 'string' ? question.header.trim() : ''
    if (header !== '') lines.push(`【${header}】`)
    const text = typeof question?.question === 'string' ? question.question.trim() : ''
    lines.push(text === '' ? '（未命名的问题）' : text)
    const detail = typeof question?.detail === 'string' ? question.detail.trim() : ''
    if (detail !== '') lines.push(detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail)
    const options: Array<{ label?: string; description?: string } | string> = Array.isArray(question?.options) ? question.options : []
    options.forEach((option, optionIndex) => {
      const label = typeof option === 'string' ? option : typeof option?.label === 'string' ? option.label : String(option)
      const description = typeof option === 'object' && option !== null && typeof option.description === 'string' ? option.description.trim() : ''
      lines.push(`${optionIndex + 1}. ${label}${description === '' ? '' : ` — ${description}`}`)
    })
    if (options.length === 0) lines.push('回复文字，或回复「跳过」。')
    else if (question.multiple === true) lines.push('回复序号，可用逗号分隔多个序号。也可回复「跳过」。')
    else lines.push('回复一个序号，或回复「跳过」。')
  })
  if (several) lines.push('请在同一条消息里按顺序回答，一题一行，也可以用分号分隔。')
  if (waitMs !== undefined) lines.push(`【回复时限】${interactionValidity(waitMs)}`)
  return chatParagraphs(...lines)
}

/** `1` / `1.` / `１` / `1,3` → option numbers; `undefined` when it is free text. */
function optionNumbers(line: string, max: number): { numbers: number[]; invalid: boolean } | undefined {
  const normalized = line.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).trim()
  const parts = normalized.split(/[,，、\s]+/).filter((part) => part !== '')
  const numbers: number[] = []
  let invalid = false
  for (const part of parts) {
    const match = /^(\d{1,2})\s*[.、。]?$/.exec(part)
    if (match === null) return undefined
    const value = Number(match[1])
    if (value < 1 || value > max) invalid = true
    else numbers.push(value)
  }
  if (numbers.length === 0 && invalid === false) return undefined
  return { numbers, invalid }
}

/** One line of reply → one answer. `null` means "not an answer at all". */
export function parseOneQuestion(text: string, question: AskUserQuestionItem): { ok: true; answer: QuestionAnswer } | { ok: false; hint: string } | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const id = typeof question.id === 'string' && question.id !== '' ? question.id : String(question.header ?? question.question ?? '')
  if (SKIP_TOKENS.has(raw.toLowerCase())) return { ok: true, answer: { id, selected: [] } }

  const options = Array.isArray(question.options) ? question.options : []
  if (options.length === 0) {
    // No options: the reply itself is the answer.
    return { ok: true, answer: { id, selected: [], custom: raw } }
  }
  const parsedNumbers = optionNumbers(raw, options.length)
  if (parsedNumbers === undefined) {
    // Free text is only a valid answer when the question has no options; a
    // question with options expects a number, otherwise "yes" would silently
    // mean option one on one host and nothing on another.
    return { ok: false, hint: `回复序号（1-${options.length}），或者回复「跳过」。` }
  }
  if (parsedNumbers.invalid === true) return { ok: false, hint: `序号要在 1-${options.length} 之间。` }
  if (question.multiple !== true && parsedNumbers.numbers.length > 1) {
    return { ok: false, hint: '这题只能选一个。' }
  }
  return { ok: true, answer: { id, selected: parsedNumbers.numbers.map((value) => String(value)) } }
}

/**
 * Parse one reply for the whole question set.
 *
 * One question takes the whole message (a free-text answer may contain
 * newlines); several are answered in order, one per line or separated by
 * `;` — a phone keyboard produces either.
 */
export function parseAnswers(text: string, questions: readonly AskUserQuestionItem[]): { ok: true; answers: QuestionAnswer[] } | { ok: false; hint: string } {
  const list = Array.isArray(questions) ? questions : []
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, hint: '回复序号或者文字。' }
  if (list.length === 1) {
    const parsed = parseOneQuestion(raw, list[0] as AskUserQuestionItem)
    return parsed === null ? { ok: false, hint: '回复序号或者文字。' } : parsed.ok === true ? { ok: true, answers: [parsed.answer] } : parsed
  }
  const lines = raw
    .split(/\r?\n|[；;]/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length !== list.length) {
    return { ok: false, hint: `共 ${list.length} 题。请在同一条消息里按顺序回答，一题一行或用分号分隔。` }
  }
  const answers: QuestionAnswer[] = []
  for (const [index, question] of list.entries()) {
    const parsed = parseOneQuestion(lines[index] as string, question)
    if (parsed === null) return { ok: false, hint: `第 ${index + 1} 题还没有回复。` }
    if (parsed.ok !== true) return parsed
    answers.push(parsed.answer)
  }
  return { ok: true, answers }
}

/** Build the queue entry for one question request. */
export function questionEntry({ target, questions, hint }: { target: Target; questions: readonly AskUserQuestionItem[]; hint?: string }): InteractionEntry {
  return {
    kind: 'question',
    target,
    view: { title: formatQuestionPrompt(questions), options: [], ...(hint === undefined ? {} : { hint }) },
    freeText: questions.every((question) => !Array.isArray(question?.options) || question.options.length === 0),
    parse(text: string) {
      const parsed = parseAnswers(text, questions)
      return parsed.ok === true ? { ok: true, value: JSON.stringify({ answers: parsed.answers }) } : { ok: false, hint: parsed.hint }
    },
    expiredNotice: '聊天答复已超时。请在 DSH 查看任务是否仍在等待回答。',
    retiredNotice: '问题已在 DSH 处理。',
    retireValue: JSON.stringify({ answers: [] }),
  }
}

/**
 * The `user-questions/request` listener body: race the chat against the next
 * answerer and return the first real answer.
 */
export async function answerUserQuestion({
  queue,
  target,
  questions,
  request,
  next,
  enabled = true,
  logger = { info: () => {}, warn: () => {} },
}: {
  queue: InteractionQueue
  target: Target | undefined
  questions: readonly AskUserQuestionItem[]
  request: { signal?: AbortSignal }
  next: () => Promise<unknown>
  enabled?: boolean
  logger?: { info: (line: string) => void; warn: (line: string) => void }
}): Promise<unknown> {
  if (enabled !== true || target === undefined) return next()
  const entry = questionEntry({ target, questions })
  const remote = queue
    .ask(entry, { ...(request.signal === undefined ? {} : { signal: request.signal }) })
    .then((value) => ({ side: 'remote' as const, ok: true as const, value: JSON.parse(value) as { answers: QuestionAnswer[] } }), (error: unknown) => ({ side: 'remote' as const, ok: false as const, error }))
  const local = Promise.resolve()
    .then(() => next())
    .then((value) => ({ side: 'local' as const, ok: true as const, value }), (error: unknown) => ({ side: 'local' as const, ok: false as const, error }))

  const first = await withinLifetime(Promise.race([remote, local]), request.signal)
  if (first.ok === true) {
    if (first.side === 'local') queue.retire(entry)
    return first.value
  }
  const other = await withinLifetime<Awaited<typeof local> | Awaited<typeof remote>>(first.side === 'remote' ? local : remote, request.signal)
  if (other.ok === true) {
    if (other.side === 'local') queue.retire(entry)
    return other.value
  }
  const error = first.side === 'local' ? first.error : other.error
  logger.warn(`no answer to the agent's question: ${String((error as Error)?.message ?? error)}`)
  throw error instanceof Error ? error : new Error(String(error))
}
