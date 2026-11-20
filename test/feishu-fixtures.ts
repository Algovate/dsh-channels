/**
 * A fake Feishu HTTP surface for the adapter tests: gateway ticket, tenant
 * token, and a resource download whose body the caller can choose.
 */
import type { FetchLike } from '../packages/adapter-feishu/src/transport.js'

export function wsFetch(resourceBody = 'image-bytes'): FetchLike {
  return (async (url: string) => {
    if (url.endsWith('/callback/ws/endpoint')) {
      return {
        ok: true, status: 200, body: null,
        json: async () => ({
          code: 0,
          data: { URL: 'wss://gateway/ws?service_id=7', ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 0, ReconnectNonce: 0 } },
        }),
      }
    }
    if (url.endsWith('/tenant_access_token/internal')) {
      return { ok: true, status: 200, body: null, json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) }
    }
    if (url.includes('/resources/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(resourceBody))
            controller.close()
          },
        }),
      }
    }
    return { ok: true, status: 200, body: null, json: async () => ({ code: 0 }) }
  }) as FetchLike
}
