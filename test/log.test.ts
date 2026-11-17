import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogger } from '../packages/core/src/log.js'

test('refusal logs retain the platform sender id while redacting credentials', () => {
  const sender = 'abcdef0123456789abcdef0123456789@im.wechat'
  const credential = 'secret1234567890secret1234567890'
  const records: string[] = []
  const logger = createLogger({ stateRoot: '/tmp', write: (_file, line) => records.push(line) })
  logger.info(`refused weixin message from ${sender}: not-allowed (0 allowed sender(s))`)
  logger.warn(`bad token=${credential}`)
  assert.ok(records[0]?.includes(sender))
  assert.ok(records[1]?.includes('token=[redacted]'))
  assert.ok(!records[1]?.includes(credential))
})
