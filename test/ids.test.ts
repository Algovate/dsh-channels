import assert from 'node:assert/strict'
import test from 'node:test'

import { lineKey, sessionIdFor } from '../packages/core/src/ids.js'

const target = { channel: 'weixin', accountId: 'acct', conversationId: 'conv' }

test('the session id is derived from the conversation and stable across calls', () => {
  assert.equal(sessionIdFor(target), sessionIdFor({ ...target }))
  assert.match(sessionIdFor(target), /^chan-weixin-[0-9a-f]{16}$/)
})

test('two conversations never share a session, and neither do two accounts', () => {
  const a = sessionIdFor(target)
  const b = sessionIdFor({ ...target, conversationId: 'other' })
  const c = sessionIdFor({ ...target, accountId: 'other' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
})

test('the line key names its three parts in order', () => {
  assert.equal(lineKey(target), 'weixin|acct|conv')
})
