import assert from 'node:assert/strict'
import test from 'node:test'

import { InteractionQueue, type InteractionEntry } from '../packages/core/src/interaction/queue.js'
import type { Outgoing, Target } from '../packages/core/src/types.js'

const target: Target = { channel: 'fake', accountId: 'acct', conversationId: 'conv' }
const other: Target = { ...target, conversationId: 'conv-2' }
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function entry(overrides: Partial<InteractionEntry> = {}): InteractionEntry {
  return {
    kind: 'question',
    target,
    view: { title: '问题', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
    parse: (text: string) => (text === '1' ? { ok: true, value: 'a' } : text === '2' ? { ok: true, value: 'b' } : { ok: false, hint: '回复 1 或 2' }),
    expiredNotice: '过期了',
    retiredNotice: '在别处答了',
    retireValue: 'retired',
    ...overrides,
  }
}

function queue(options: { timeoutMs?: number } = {}) {
  const sent: Array<{ target: Target; outgoing: Outgoing }> = []
  const instance = new InteractionQueue({
    send: async (to, outgoing) => {
      sent.push({ target: to, outgoing })
    },
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: options.timeoutMs ?? 10_000,
  })
  return { instance, sent }
}

test('the prompt is sent once, numbered, with the reply syntax and the deadline', async () => {
  const { instance, sent } = queue({ timeoutMs: 5 * 60_000 })
  const answer = instance.ask(entry())
  await tick(0)
  assert.equal(sent.length, 1)
  const text = sent[0]?.outgoing.text ?? ''
  assert.match(text, /^问题/)
  assert.match(text, /1\. 甲/)
  assert.match(text, /2\. 乙/)
  assert.match(text, /回复序号/)
  assert.match(text, /5 分钟/)
  assert.equal(sent[0]?.outgoing.kind, 'question')
  assert.equal(instance.claim(target, '1').status, 'answered')
  assert.equal(await answer, 'a')
})

test('an unparsable reply keeps the prompt alive and returns a hint', async () => {
  const { instance } = queue()
  const answer = instance.ask(entry())
  await tick(0)
  assert.deepEqual(instance.claim(target, '也许吧'), { status: 'invalid', hint: '回复 1 或 2' })
  assert.equal(instance.claim(target, '2').status, 'answered')
  assert.equal(await answer, 'b')
})

test('a second interaction waits its turn and both get their own prompt', async () => {
  const { instance, sent } = queue()
  const first = instance.ask(entry({ view: { title: '第一个', options: [] } }))
  await tick(0)
  const second = instance.ask(entry({ view: { title: '第二个', options: [] } }))
  await tick(0)
  assert.equal(sent.length, 1, 'only the head is on screen')
  assert.equal(instance.claim(target, '1').status, 'answered')
  await first
  await tick(0)
  assert.equal(sent.length, 2)
  assert.equal(sent[1]?.outgoing.text?.startsWith('第二个'), true)
  instance.claim(target, '1')
  await second
})

test('a question for another conversation does not block this one', async () => {
  const { instance } = queue()
  const a = instance.ask(entry())
  const b = instance.ask(entry({ target: other, view: { title: '别处', options: [] } }))
  await tick(0)
  assert.equal(instance.claim(target, '1').status, 'answered')
  assert.equal(instance.claim(other, '1').status, 'answered')
  assert.equal(await a, 'a')
  assert.equal(await b, 'a')
})

test('the wait expires, tells the person, and rejects with ETIMEDOUT', async () => {
  const { instance, sent } = queue({ timeoutMs: 10 })
  const answer = instance.ask(entry())
  await assert.rejects(answer, (error: NodeJS.ErrnoException) => error.code === 'ETIMEDOUT')
  const notice = sent.find((item) => item.outgoing.kind === 'notice')
  assert.equal(notice?.outgoing.text, '过期了')
})

test('an aborted request withdraws the prompt without inventing an answer', async () => {
  const { instance } = queue()
  const controller = new AbortController()
  const answer = instance.ask(entry(), { signal: controller.signal })
  controller.abort()
  await assert.rejects(answer, /withdrawn/)
  assert.equal(instance.busy(target), false)
})

test('retiring sends the "answered elsewhere" notice and resolves with the retire value', async () => {
  const { instance, sent } = queue()
  const answer = instance.ask(entry())
  await tick(0)
  instance.retire(target)
  assert.equal(await answer, 'retired')
  assert.ok(sent.some((item) => item.outgoing.text === '在别处答了'))
})

test('dispose rejects every waiting interaction', async () => {
  const { instance } = queue()
  const answer = instance.ask(entry())
  instance.dispose()
  await assert.rejects(answer, /disposed/)
})

test('a failed prompt delivery rejects instead of waiting out the timeout', async () => {
  const sent: Outgoing[] = []
  const instance = new InteractionQueue({
    send: async (_target, outgoing) => {
      sent.push(outgoing)
      throw new Error('channel down')
    },
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: 10_000,
  })
  await assert.rejects(instance.ask(entry()), /could not deliver/)
})
