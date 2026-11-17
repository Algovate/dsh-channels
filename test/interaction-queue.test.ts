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
      return [{ ok: true, unconfirmed: true }]
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
  await tick()
  assert.equal(instance.busy(target), false)
})

test('retiring sends the "answered elsewhere" notice and resolves with the retire value', async () => {
  const { instance, sent } = queue()
  const prompt = entry()
  const answer = instance.ask(prompt)
  await tick(0)
  instance.retire(prompt)
  assert.equal(await answer, 'retired')
  assert.ok(sent.some((item) => item.outgoing.text === '在别处答了'))
})

test('dispose rejects every waiting interaction without presenting queued prompts', async () => {
  const { instance, sent } = queue()
  const first = assert.rejects(instance.ask(entry()), /disposed/)
  const second = assert.rejects(instance.ask(entry()), /disposed/)
  await tick()
  instance.dispose()
  await Promise.all([first, second])
  assert.equal(sent.length, 1)
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

test('a request with an already aborted signal rejects without sending a prompt', async () => {
  const { instance, sent } = queue()
  const answer = instance.ask(entry(), { signal: AbortSignal.abort() })
  await Promise.race([assert.rejects(answer, /withdrawn/), tick(10).then(() => assert.fail('aborted request is still pending'))])
  assert.deepEqual(sent, [])
  assert.equal(instance.busy(target), false)
})

test('withdrawing a queued request does not send the active prompt again', async () => {
  const { instance, sent } = queue()
  const first = instance.ask(entry())
  const controller = new AbortController()
  const second = assert.rejects(instance.ask(entry(), { signal: controller.signal }), /withdrawn/)
  controller.abort()
  await second
  assert.equal(sent.length, 1)
  assert.equal(instance.claim(target, '1').status, 'answered')
  assert.equal(await first, 'a')
})

test('a resolved delivery failure rejects an interaction without waiting for a reply', async () => {
  const instance = new InteractionQueue({
    send: async () => [{ ok: true, messageId: 'first-fragment' }, { ok: false, code: 'channel-down' }],
    logger: { info: () => {}, warn: () => {} },
  })
  const answer = instance.ask(entry())
  await Promise.race([assert.rejects(answer, /channel-down/), tick(10).then(() => assert.fail('undeliverable request is still pending'))])
  assert.equal(instance.busy(target), false)
})

test('a retired prompt and its notice finish sending before the next prompt can take a reply', async () => {
  let releaseFirst = () => {}
  let releaseNotice = () => {}
  const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve })
  const noticeSend = new Promise<void>((resolve) => { releaseNotice = resolve })
  const started: string[] = []
  const instance = new InteractionQueue({
    send: async (_target, outgoing) => {
      const title = outgoing.text?.split('\n')[0] ?? ''
      started.push(title)
      if (title === 'First question') await firstSend
      if (outgoing.kind === 'notice') await noticeSend
      return [{ ok: true, unconfirmed: true }]
    },
    logger: { info: () => {}, warn: () => {} },
  })
  const firstEntry = entry({ view: { title: 'First question', options: [] } })
  const first = instance.ask(firstEntry)
  const second = instance.ask(entry({ kind: 'approval', view: { title: 'Second approval', options: [] } }))
  await tick()
  assert.deepEqual(started, ['First question'])

  instance.retire(firstEntry)
  assert.equal(await first, 'retired')
  assert.equal(instance.claim(target, '1').status, 'waiting', 'a reply to the first prompt cannot approve the second')
  assert.deepEqual(started, ['First question'])

  releaseFirst()
  await tick()
  assert.deepEqual(started, ['First question', '在别处答了'])
  assert.equal(instance.claim(target, '1').status, 'waiting')

  releaseNotice()
  await tick()
  assert.deepEqual(started, ['First question', '在别处答了', 'Second approval'])
  assert.equal(instance.claim(target, '2').status, 'answered')
  assert.equal(await second, 'b')
})
