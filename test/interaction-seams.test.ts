import assert from 'node:assert/strict'
import test from 'node:test'

import { answerApproval, formatApprovalPrompt, parseApprovalOutcome } from '../packages/core/src/interaction/approval.js'
import { answerUserQuestion, formatQuestionPrompt, parseAnswers, parseOneQuestion } from '../packages/core/src/interaction/questions.js'
import { InteractionQueue } from '../packages/core/src/interaction/queue.js'
import type { Outgoing, Target } from '../packages/core/src/types.js'

const target: Target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const silent = { info: () => {}, warn: () => {} }

function queue() {
  const sent: Outgoing[] = []
  const instance = new InteractionQueue({
    send: async (_target, outgoing) => {
      sent.push(outgoing)
    },
    logger: silent,
    timeoutMs: 10_000,
  })
  return { instance, sent }
}

test('a single question renders header, text, options and descriptions', () => {
  const prompt = formatQuestionPrompt([{ header: '口味', question: '喝什么', detail: '只能选一个', options: [{ label: '咖啡', description: '热的' }, { label: '茶' }] }], { waitMs: 120_000 })
  assert.match(prompt, /^【提问】/)
  assert.match(prompt, /【口味】/)
  assert.match(prompt, /喝什么/)
  assert.match(prompt, /只能选一个/)
  assert.match(prompt, /1\. 咖啡 — 热的/)
  assert.match(prompt, /2\. 茶/)
  assert.match(prompt, /2 分钟内有效/)
})

test('several questions are numbered and say how to answer', () => {
  const prompt = formatQuestionPrompt([{ question: 'A' }, { question: 'B' }])
  assert.match(prompt, /第 1 题/)
  assert.match(prompt, /第 2 题/)
  assert.match(prompt, /一题一行/)
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
  assert.match(prompt, /bash 想要执行/)
  assert.match(prompt, /安装依赖/)

  const { instance, sent } = queue()
  const pending = instance.ask({
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
  })
  void pending
  void sent
  instance.retire(target)
  assert.equal(instance.busy(target), false)
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
  assert.equal(instance.busy(target), false)
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

test('both question surfaces failing throws the seam\'s own error', async () => {
  const instance = new InteractionQueue({
    send: async () => {},
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
  assert.equal(instance.claim(target, '1').status, 'answered')
  assert.equal(await answer, 'allowed-once')
})

test('nobody deciding yields unavailable, not a fabricated rejection', async () => {
  const { instance } = queue()
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
