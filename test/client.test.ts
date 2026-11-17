import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/**
 * The Web client is a plain script that registers a lazy factory with the
 * browser's module loader. Loading it here with a fake loader answers the
 * questions the GUI cannot: does it register at all, does the Definition claim
 * only this channel's messages, and does the renderer produce the badge.
 */
interface Registered {
  id: string
  factory: (require: (name: string) => unknown) => {
    inject: string[]
    apply: (ctx: unknown) => (() => void) | undefined
  }
}

let loadCount = 0

/**
 * Run `body` with the browser globals installed. `apply()` reads
 * `navigator.language`, so the globals have to live for the whole test, not
 * just the import.
 */
async function withClient<T>(language: string, body: (client: Registered) => T | Promise<T>): Promise<T> {
  const client = await loadClient(language)
  try {
    return await body(client)
  } finally {
    restoreGlobals()
  }
}

function restoreGlobals(): void {
  Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true })
  delete (globalThis as { navigator?: unknown }).navigator
}

async function loadClient(language = 'zh-CN'): Promise<Registered> {
  let registered: Registered | undefined
  const windowObject = {
    __ModuleLoader__: {
      load: (entry: Registered) => {
        registered = entry
      },
    },
  }
  // `navigator` is a getter-only global in Node, so it is installed with
  // defineProperty and removed again rather than assigned.
  const defineGlobal = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const previousWindow = (globalThis as { window?: unknown }).window
  defineGlobal('window', windowObject)
  defineGlobal('navigator', { language })
  try {
    // A unique query re-executes the module: the browser loader would load it
    // once, but each test needs its own registration.
    loadCount += 1
    await import(`${pathToFileURL(path.resolve(process.cwd(), 'packages/core/client.js')).href}?v=${loadCount}`)
  } finally {
    // Globals are removed by restoreGlobals() once the caller's body ran; keep
    // them installed until then.
    void previousWindow
  }
  assert.ok(registered !== undefined, 'the client must register a module')
  return registered
}

const react = {
  createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
}

test('the client registers under the package id the loader expects', async () => {
  await withClient('zh-CN', (client) => {
    assert.equal(client.id, '@rodin/dsh-channels')
    assert.equal(typeof client.factory, 'function')
  })
})

test('the row claims weixin user messages exclusively and nothing else', async () => {
  await withClient('zh-CN', (client) => {
  const module = client.factory((name: string) => (name === 'react' ? react : undefined))
  const definitions: Array<Record<string, any>> = []
  const seats: Array<Record<string, any>> = []
  const scope = {
    uiConversation: { events: { register: (definition: Record<string, any>) => definitions.push(definition) } },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (seat: Record<string, any>) => seats.push(seat),
    },
  }
  const dispose = module.apply({
    inject: (_services: string[], callback: (scope: unknown) => unknown) => {
      callback(scope)
      return { dispose: () => {} }
    },
  })
  assert.equal(typeof dispose, 'function', 'apply must return a disposer function, not the injection handle')
  assert.equal(definitions.length, 2, 'one row per known channel')
  const weixin = definitions.find((definition) => definition.kind === 'weixin-user')
  assert.ok(weixin !== undefined)
  assert.equal(definitions[0]?.kind, 'weixin-user')
  assert.equal(definitions[0]?.target, 'chat')

  const match = weixin?.match as (event: unknown) => Record<string, any> | null
  assert.deepEqual(match({ type: 'user/message', data: { id: 'm1', source: { kind: 'weixin', conversationId: 'c' } } }), {
    id: 'm1',
    role: 'start',
    exclusive: true,
  })
  assert.equal(match({ type: 'user/message', data: { id: 'm2', source: { kind: 'user' } } }), null)
  assert.equal(match({ type: 'assistant/message', data: { source: { kind: 'weixin' } } }), null)

  assert.equal(seats[0]?.name, 'conversation.chat.node')
  assert.equal(seats[0]?.key, 'weixin-user')
  const telegram = definitions.find((definition) => definition.kind === 'telegram-user')
  assert.ok(telegram !== undefined, 'the second channel gets its own row')
  assert.equal(typeof dispose, 'function')
  dispose?.()
  assert.equal(definitions.length, 2, 'registration happened once')
  })
})

test('the renderer shows the channel badge, the sender and the words', async () => {
  await withClient('zh-CN', (client) => {
  const module = client.factory((name: string) => (name === 'react' ? react : undefined))
  const definitions: Array<Record<string, any>> = []
  const renderers: Array<(props: unknown) => any> = []
  const scope = {
    remote: {},
    uiConversation: { events: { register: (definition: Record<string, any>) => definitions.push(definition) } },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (_seat: Record<string, any>, renderer: (props: unknown) => any) => renderers.push(renderer),
    },
  }
  module.apply({
    inject: (_services: string[], callback: (scope: unknown) => unknown) => {
      callback(scope)
      return { dispose: () => {} }
    },
  })
  const renderer = renderers[0]
  assert.ok(renderer !== undefined)

  const weixinDefinition = definitions.find((definition) => definition.kind === 'weixin-user')
  const start = weixinDefinition?.start as (context: unknown, match: unknown) => Record<string, any>
  const data = start({}, { event: { data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'weixin', senderId: 'abcdefghijklmnop@im.wechat', group: false } } } })
  const node = renderer({ node: { data } })
  const text = JSON.stringify(node)
  assert.match(text, /微信/)
  assert.match(text, /abcdefghijkl/, 'the short sender id is shown')
  assert.match(text, /你好/)
  })
})

test('an English page gets English labels', async () => {
  await withClient('en-US', (client) => {
  const module = client.factory((name: string) => (name === 'react' ? react : undefined))
  const renderers: Array<(props: unknown) => any> = []
  const scope = {
    remote: {},
    uiConversation: { events: { register: () => {} } },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (_seat: Record<string, any>, renderer: (props: unknown) => any) => renderers.push(renderer),
    },
  }
  module.apply({
    inject: (_services: string[], callback: (scope: unknown) => unknown) => {
      callback(scope)
      return { dispose: () => {} }
    },
  })
  const node = renderers[0]?.({ node: { data: { text: '', group: false, senderId: '', others: 0 } } })
  const text = JSON.stringify(node)
  assert.match(text, /WeChat/)
  assert.match(text, /\(empty message\)/)
  })
})

test('the card asks the host for status through the channels namespace', async () => {
  await withClient('zh-CN', (client) => {
    const module = client.factory((name: string) => (name === 'react' ? react : undefined))
    const seats: Array<Record<string, any>> = []
    const calls: string[] = []
    const scope = {
      remote: {
        channels: {
          status: async () => {
            calls.push('status')
            return { ok: true, value: { stateRoot: '/s', channels: [], allowlist: ['a'], outboxPending: 0, journal: [], interactions: { pending: false } } }
          },
        },
      },
      uiConversation: { events: { register: () => {} } },
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (seat: Record<string, any>) => seats.push(seat),
      },
    }
    const dispose = module.apply({
      inject: (_services: string[], callback: (scope: unknown) => unknown) => {
        callback(scope)
        return { dispose: () => {} }
      },
    })
    const card = seats.find((seat) => seat.name === 'plugins.bundle.config')
    assert.ok(card !== undefined, 'the card registers in the plugin page seat')
    assert.equal(card?.key, '@rodin/dsh-channels')
    assert.equal(typeof dispose, 'function')
    assert.equal(calls.length, 0, 'nothing is fetched until the card mounts')
  })
})
