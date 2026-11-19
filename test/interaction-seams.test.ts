import assert from 'node:assert/strict'
import test from 'node:test'
import { keepHostAlive } from './host-lifetime.js'

import { approvalEntry, answerApproval, formatApprovalPrompt, parseApprovalOutcome } from '../packages/core/src/interaction/approval.js'
import { answerUserQuestion, formatQuestionPrompt, parseAnswers, parseOneQuestion } from '../packages/core/src/interaction/questions.js'
import { InteractionQueue, type InteractionEntry } from '../packages/core/src/interaction/queue.js'
import type { Outgoing, Target } from '../packages/core/src/types.js'

keepHostAlive()

const target: Target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const silent = { info: () => {}, warn: () => {} }

function queue(timeoutMs = 10_000) {
  const sent: Outgoing[] = []
  const instance = new InteractionQueue({
    send: async (_target, outgoing) => {
      sent.push(outgoing)
      return [{ ok: true, unconfirmed: true }]
    },
    logger: silent,
    timeoutMs,
  })
  return { instance, sent }
}

test('approval lifetime withdraws the original entry even when prompt expiry is delayed', async () => {
  const { instance } = queue()
  const ask = instance.ask.bind(instance)
  // Keep the real queue, but delay its own expiry beyond the seam's deadline.
  instance.ask = (entry, options) => ask(entry, { signal: options?.signal })
  try {
    const result = await answerApproval({ queue: instance, target, request: { deadlineAt: Date.now() + 20 }, next: () => new Promise(() => {}) })
    assert.equal(result, 'unavailable')
    assert.equal(instance.pendingCount(), 0)
  } finally { instance.dispose() }
})

test('a single question renders header, text, options and descriptions', () => {
  const prompt = formatQuestionPrompt([{ header: '口味', question: '喝什么', detail: '只能选一个', options: [{ label: '咖啡', description: '热的' }, { label: '茶' }] }], { waitMs: 120_000 })
  assert.match(prompt, /^【提问】/)
  assert.match(prompt, /【口味】/)
  assert.match(prompt, /喝什么/)
  assert.match(prompt, /只能选一个/)
  assert.match(prompt, /1\. 咖啡 — 热的/)
  assert.match(prompt, /\n\n1\. 咖啡 — 热的\n\n2\. 茶\n\n回复一个序号/)
  assert.match(prompt, /2 分钟内有效/)
})

test('several questions are numbered and say how to answer', () => {
  const prompt = formatQuestionPrompt([{ question: 'A' }, { question: 'B' }])
  assert.match(prompt, /第 1 题/)
  assert.match(prompt, /第 2 题/)
  assert.match(prompt, /一题一行/)
})

test('a free-text question tells the chat to reply in words', async () => {
  const { instance, sent } = queue()
  const answer = answerUserQuestion({
    queue: instance, target, questions: [{ id: 'q', question: '写什么？' }],
    request: {}, next: () => new Promise(() => {}), logger: silent,
  })
  await tick()
  assert.equal(instance.claim(target, '周报').status, 'answered')
  await answer
  const prompt = sent[0]?.text ?? ''
  assert.match(prompt, /回复文字/)
  assert.doesNotMatch(prompt, /回复序号/)
  assert.match(prompt, /10 秒内有效/)
})

test('approval decisions display full reply codes without bare numbered choices', async () => {
  const { instance, sent } = queue()
  const entry = approvalEntry({ target, request: { toolName: 'bash', reason: '安装依赖' } })
  const answer = instance.ask(entry)
  await tick()
  const prompt = sent[0]?.text ?? ''
  const code = prompt.match(/[a-f0-9]{6}/)?.[0]
  assert.ok(code)
  assert.equal(instance.claim(target, `${code} 3`).status, 'answered')
  assert.equal(await answer, 'cancelled')
  assert.ok(prompt.includes(`「${code} 1」允许一次\n\n「${code} 2」拒绝\n\n「${code} 3」取消审批`))
  assert.doesNotMatch(prompt, /^1\./m)
})

test('an option answer keeps the host vocabulary: id + selected', () => {
  const parsed = parseOneQuestion('2', { id: 'q1', options: [{ label: '甲' }, { label: '乙' }] })
  assert.deepEqual(parsed, { ok: true, answer: { id: 'q1', selected: ['2'] } })
})

test('full-width digits, a trailing dot and a comma list are accepted', () => {
  assert.deepEqual(parseOneQuestion('１', { id: 'q', options: [{}, {}] }), { ok: true, answer: { id: 'q', selected: ['1'] } })
  assert.deepEqual(parseOneQuestion('2.', { id: 'q', options: [{}, {}] }), { ok: true, answer: { id: 'q', selected: ['2'] } })
  assert.deepEqual(parseOneQuestion('1，2', { id: 'q', options: [{}, {}], multiple: true }), { ok: true, answer: { id: 'q', selected: ['1', '2'] } })
})

test('a numeric answer outside the range is refused without consuming the question', () => {
  const parsed = parseOneQuestion('9', { id: 'q', options: [{}] })
  assert.equal(parsed?.ok, false)
  assert.match((parsed as { hint: string }).hint, /1-1/)
})

test('several selections on a single-select question are refused', () => {
  const parsed = parseOneQuestion('1,2', { id: 'q', options: [{}, {}] })
  assert.equal(parsed?.ok, false)
  assert.match((parsed as { hint: string }).hint, /只能选一个/)
})

test('skip words answer with an empty selection, and a free-text question takes the text', () => {
  assert.deepEqual(parseOneQuestion('跳过', { id: 'q', options: [{}] }), { ok: true, answer: { id: 'q', selected: [] } })
  assert.deepEqual(parseOneQuestion('随便说点什么', { id: 'q', options: [] }), { ok: true, answer: { id: 'q', selected: [], custom: '随便说点什么' } })
})

test('a question with options refuses free text rather than guessing', () => {
  const parsed = parseOneQuestion('好啊', { id: 'q', options: [{}, {}] })
  assert.equal(parsed?.ok, false)
})

test('several questions need one line each, and both separators work', () => {
  const questions = [{ id: 'a', options: [{}, {}] }, { id: 'b', options: [{}, {}] }]
  assert.deepEqual(parseAnswers('1\n2', questions), { ok: true, answers: [{ id: 'a', selected: ['1'] }, { id: 'b', selected: ['2'] }] })
  assert.deepEqual(parseAnswers('1；2', questions), { ok: true, answers: [{ id: 'a', selected: ['1'] }, { id: 'b', selected: ['2'] }] })
  assert.equal(parseAnswers('1', questions).ok, false)
})

test('the approval prompt names the tool and the decision numbers', () => {
  const prompt = formatApprovalPrompt({ toolName: 'bash', reason: '安装依赖' })
  assert.match(prompt, /【需要批准】/)
  assert.match(prompt, /工具：bash/)
  assert.match(prompt, /安装依赖/)

  const { instance, sent } = queue()
  const entry: InteractionEntry = {
    kind: 'approval',
    target,
    view: { title: prompt, options: [{ id: 'allowed-once', label: '允许（只这一次）' }, { id: 'rejected', label: '拒绝' }] },
    parse: (text) => {
      const outcome = parseApprovalOutcome(text)
      return outcome === null ? { ok: false, hint: 'x' } : { ok: true, value: outcome }
    },
    expiredNotice: '',
    retiredNotice: '',
    retireValue: 'unavailable',
  }
  const pending = instance.ask(entry)
  void pending
  void sent
  instance.retire(entry)
  assert.equal(instance.active(target), undefined)
})

test('approval words map to the seam outcomes', () => {
  assert.equal(parseApprovalOutcome('1'), 'allowed-once')
  assert.equal(parseApprovalOutcome('允许'), 'allowed-once')
  assert.equal(parseApprovalOutcome('yes'), 'allowed-once')
  assert.equal(parseApprovalOutcome('2'), 'rejected')
  assert.equal(parseApprovalOutcome('拒绝'), 'rejected')
  assert.equal(parseApprovalOutcome('取消'), 'cancelled')
  assert.equal(parseApprovalOutcome('再说吧'), null)
})

test('a question is answered from the chat and the desktop is retired', async () => {
  const { instance, sent } = queue()
  const desktopCalled: number[] = []
  const answer = answerUserQuestion({
    queue: instance,
    target,
    questions: [{ id: 'q', question: '哪个', options: [{ label: '甲' }, { label: '乙' }] }],
    request: {},
    next: async () => {
      desktopCalled.push(1)
      return new Promise(() => {})
    },
    logger: silent,
  })
  await tick(5)
  assert.equal(desktopCalled.length, 1, 'the desktop answerer still sees the request')
  const prompt = sent.find((outgoing) => outgoing.kind === 'question')
  assert.ok(prompt !== undefined)
  assert.equal(instance.claim(target, '2').status, 'answered')
  assert.deepEqual(await answer, { answers: [{ id: 'q', selected: ['2'] }] })
})

test('when the desktop answers first, the chat prompt is retired', async () => {
  const { instance, sent } = queue()
  const answer = answerUserQuestion({
    queue: instance,
    target,
    questions: [{ id: 'q', question: '哪个', options: [{ label: '甲' }] }],
    request: {},
    next: async () => ({ answers: [{ id: 'q', selected: ['1'] }] }),
    logger: silent,
  })
  assert.deepEqual(await answer, { answers: [{ id: 'q', selected: ['1'] }] })
  assert.equal(instance.active(target), undefined)
  await tick()
  assert.ok(sent.some((outgoing) => outgoing.kind === 'notice'), 'the person is told it was answered elsewhere')
})

test('a question outside this channel falls through to the next answerer', async () => {
  const { instance } = queue()
  const answer = await answerUserQuestion({
    queue: instance,
    target: undefined,
    questions: [{ question: 'x', options: [] }],
    request: {},
    next: async () => 'desktop-only',
    logger: silent,
  })
  assert.equal(answer, 'desktop-only')
})

test('a desktop answer retires only its own queued question', async () => {
  const { instance, sent } = queue()
  const first = answerApproval({
    queue: instance,
    target,
    request: { toolName: 'first-tool' },
    next: async () => 'unavailable',
    logger: silent,
  })
  const second = await answerUserQuestion({
    queue: instance,
    target,
    questions: [{ id: 'other', question: 'Already answered' }],
    request: {},
    next: async () => ({ answers: [{ id: 'other', selected: [], custom: 'desktop reply' }] }),
    logger: silent,
  })
  assert.deepEqual(second, { answers: [{ id: 'other', selected: [], custom: 'desktop reply' }] })
  assert.equal(instance.active(target), 'approval')
  assert.equal(sent.length, 1)
  assert.equal(instance.claim(target, `${sent.find((item) => /需要批准/.test(item.text ?? ''))?.text?.match(/[a-f0-9]{6}/)?.[0]} 1`).status, 'answered')
  assert.equal(await first, 'allowed-once')
})

test('a desktop approval does not retire the question ahead of it', async () => {
  const { instance, sent } = queue()
  const first = answerUserQuestion({
    queue: instance,
    target,
    questions: [{ id: 'first', question: 'First question' }],
    request: {},
    next: async () => new Promise(() => {}),
    logger: silent,
  })
  const second = await answerApproval({
    queue: instance,
    target,
    request: { toolName: 'second-tool' },
    next: async () => 'rejected',
    logger: silent,
  })
  assert.equal(second, 'rejected')
  assert.equal(instance.active(target), 'question')
  assert.equal(sent.length, 1)
  assert.equal(instance.claim(target, 'chat reply').status, 'answered')
  assert.deepEqual(await first, { answers: [{ id: 'first', selected: [], custom: 'chat reply' }] })
})

test('both question surfaces failing throws the seam\'s own error', async () => {
  const instance = new InteractionQueue({
    send: async () => [{ ok: true, unconfirmed: true }],
    logger: silent,
    timeoutMs: 10,
  })
  const answer = answerUserQuestion({
    queue: instance,
    target,
    questions: [{ question: 'x', options: [] }],
    request: {},
    next: async () => {
      throw new Error('no desktop answerer')
    },
    logger: silent,
  })
  await assert.rejects(answer, /no desktop answerer/)
})

test('an approval decided in the chat wins, and the desktop may still say unavailable', async () => {
  const { instance, sent } = queue()
  const answer = answerApproval({
    queue: instance,
    target,
    request: { toolName: 'bash', reason: 'x' },
    next: async () => {
      await tick(5)
      return 'unavailable'
    },
    logger: silent,
  })
  await tick(10)
  assert.ok(sent.some((outgoing) => /需要批准/.test(outgoing.text ?? '')))
  assert.equal(instance.claim(target, `${sent.find((item) => /需要批准/.test(item.text ?? ''))?.text?.match(/[a-f0-9]{6}/)?.[0]} 1`).status, 'answered')
  assert.equal(await answer, 'allowed-once')
})

test('nobody deciding yields unavailable, not a fabricated rejection', async () => {
  const { instance } = queue(10)
  const answer = await answerApproval({
    queue: instance,
    target,
    request: { toolName: 'bash' },
    next: async () => 'unavailable',
    logger: silent,
  })
  assert.equal(answer, 'unavailable')
})

test('a disabled seam delegates without ever prompting', async () => {
  const { instance, sent } = queue()
  const value = await answerApproval({
    queue: instance,
    target,
    request: { toolName: 'bash' },
    next: async () => 'rejected',
    enabled: false,
    logger: silent,
  })
  assert.equal(value, 'rejected')
  assert.equal(sent.length, 0)
})
