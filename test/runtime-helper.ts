/**
 * Build a runtime with a fake adapter and a fake agents service.
 *
 * Kept in one place so every runtime test uses the same wiring the plugin entry
 * uses (`startChannels` loads adapters the same way: a factory returning a
 * `ChannelAdapter`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ChannelsRuntime } from '../packages/core/src/runtime.js'
import { resolveConfig, type ChannelsConfig } from '../packages/core/src/config.js'
import type { ChannelAdapter, InboundMessage, Outgoing, SendResult, Target } from '../packages/core/src/types.js'

export interface FakeAdapterOptions {
  id?: string
  /** Fail every send with this code, to exercise the outbox. */
  failWith?: string
  maxTextChars?: number
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): ChannelAdapter & { sent: Array<{ target: Target; outgoing: Outgoing }>; inbound: Array<(message: InboundMessage) => void> } {
  const sent: Array<{ target: Target; outgoing: Outgoing }> = []
  const inbound: Array<(message: InboundMessage) => void> = []
  const adapter = {
    id: options.id ?? 'fake',
    label: { zh: '测试', en: 'Fake' },
    capabilities: {
      text: true,
      media: { image: false, file: false, voice: false, video: false },
      stickers: false,
      typing: false,
      buttons: false,
      edit: false,
      maxTextChars: options.maxTextChars ?? 0,
    },
    accounts: {
      async list() {
        return [{ accountId: 'acct', expired: false }]
      },
    },
    interactions: {
      format: 'numbered' as const,
      render: (view: { title: string }) => ({ text: view.title, kind: 'question' as const }),
      parse: () => null,
    },
    async start() {},
    async stop() {},
    onInbound(handler: (message: InboundMessage) => void) {
      inbound.push(handler)
      return () => {}
    },
    async send(target: Target, outgoing: Outgoing): Promise<SendResult> {
      sent.push({ target, outgoing })
      return options.failWith === undefined ? { ok: true, messageId: `m-${sent.length}` } : { ok: false, code: options.failWith }
    },
    sent,
    inbound,
  }
  return adapter
}

export function createChannelsRuntime({
  ctx,
  config = {},
  createUserMessage,
  maxTurnWaitMs,
  pollMs,
}: {
  ctx: { get?: (name: string) => unknown }
  config?: Partial<ChannelsConfig>
  createUserMessage?: (fields: Record<string, unknown>) => unknown
  maxTurnWaitMs?: number
  pollMs?: number
}): ChannelsRuntime {
  const resolved = resolveConfig({
    maxTurnWaitMs: maxTurnWaitMs ?? 2000,
    turnPollMs: pollMs ?? 5,
    bubbleGapMs: 0,
    allowedSenders: ['sender'],
    ...config,
  })
  return new ChannelsRuntime({
    ctx,
    config: resolved,
    logger: { info: () => {}, warn: () => {} },
    stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'channels-test-')),
    workingDirectory: '/tmp',
    ...(createUserMessage === undefined ? {} : { createUserMessage }),
  })
}
