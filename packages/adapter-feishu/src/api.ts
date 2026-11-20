/**
 * The Feishu/Lark HTTP plumbing shared by every REST call the adapter makes.
 *
 * One place owns the domain, the injected `fetch`, request deadlines, lifecycle
 * cancellation and the tenant token (exchanged once and cached until near
 * expiry). Calls pass a path and a body; they never build URLs or headers
 * themselves. The gateway ticket for the persistent connection is here too,
 * because it is an ordinary authenticated-by-app-credentials POST.
 *
 * @module @derekluo/dsh-channels-feishu/api
 */

export const DEFAULT_DOMAIN = 'https://open.feishu.cn'

const REQUEST_TIMEOUT_MS = 15_000
const TOKEN_SAFETY_MS = 60_000

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  body?: ReadableStream<Uint8Array> | null
}>

export interface TransportLogger {
  info: (line: string) => void
  warn: (line: string) => void
}

export interface ApiOptions {
  appId: string
  appSecret: string
  /** Override the OpenAPI domain, e.g. https://open.larksuite.com for Lark. */
  domain?: string
  /** Injected in tests: the real fetch, so a request can be stepped. */
  fetchImpl?: FetchLike
}

export interface ApiEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

export interface ConnectConfig {
  URL: string
  ClientConfig: {
    PingInterval: number
    ReconnectCount: number
    ReconnectInterval: number
    ReconnectNonce: number
  }
}

interface TokenInfo { token: string; expiresAt: number }

export class FeishuApi {
  readonly #options: ApiOptions
  readonly #fetch: FetchLike
  readonly #domain: string
  #token: TokenInfo | undefined
  #lifecycle = new AbortController()

  get signal(): AbortSignal { return this.#lifecycle.signal }
  get domain(): string { return this.#domain }

  constructor(options: ApiOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#domain = (options.domain ?? DEFAULT_DOMAIN).replace(/\/$/, '')
  }

  start(): void {
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController()
  }

  stop(): void {
    this.#lifecycle.abort(new Error('Feishu transport stopped'))
  }

  /** One request to `path` (which must start with "/"); `timeoutMs` 0 disables the deadline. */
  async #send(path: string, init: Record<string, unknown>, timeoutMs: number): Promise<Awaited<ReturnType<FetchLike>>> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.signal, deadline.signal])
    signal.throwIfAborted()
    const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(new Error('Feishu request timed out')), timeoutMs) : undefined
    try {
      return await this.#fetch(`${this.#domain}${path}`, { ...init, signal })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** One JSON request, bounded by a deadline. */
  async request<T>(path: string, init: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ApiEnvelope<T>> {
    const response = await this.#send(path, init, timeoutMs)
    return (await response.json().catch(() => ({}))) as ApiEnvelope<T>
  }

  /**
   * One raw streaming request. Downloads can legitimately take longer than a
   * JSON call, so by default only the lifecycle signal bounds them.
   */
  requestStream(path: string, init: Record<string, unknown>, timeoutMs = 0): Promise<Awaited<ReturnType<FetchLike>>> {
    return this.#send(path, init, timeoutMs)
  }

  /** Exchange the app credentials for a tenant token, caching until near expiry. */
  async tenantToken(): Promise<string> {
    const now = Date.now()
    if (this.#token !== undefined && this.#token.expiresAt - TOKEN_SAFETY_MS > now) return this.#token.token
    const envelope = await this.request<{ tenant_access_token?: string; expire?: number }>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.#options.appId, app_secret: this.#options.appSecret }),
      },
    )
    // The token endpoint answers with the fields at the top level (no `data`
    // wrapper), unlike the rest of the OpenAPI, so accept both shapes.
    const flat = envelope as ApiEnvelope<{ tenant_access_token?: string; expire?: number }> & {
      tenant_access_token?: string
      expire?: number
    }
    const token = flat.tenant_access_token ?? envelope.data?.tenant_access_token
    if (envelope.code !== 0 || typeof token !== 'string' || token === '') {
      throw new Error(`tenant token exchange failed: ${envelope.msg ?? envelope.code ?? 'unknown error'}`)
    }
    const expireSeconds = flat.expire ?? envelope.data?.expire ?? 7200
    this.#token = { token, expiresAt: now + expireSeconds * 1000 }
    return token
  }

  /** Ensure a token, then return the auth header. Every authenticated call goes through here. */
  async auth(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.tenantToken()
    return { authorization: `Bearer ${token}`, ...(extra ?? {}) }
  }

  /** Fetch the persistent-connection ticket and the gateway's timing config. */
  async pullConnectConfig(): Promise<ConnectConfig> {
    const envelope = await this.request<ConnectConfig>('/callback/ws/endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', locale: 'zh' },
      body: JSON.stringify({ AppID: this.#options.appId, AppSecret: this.#options.appSecret }),
    })
    if (envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(`ws endpoint discovery failed: ${envelope.msg ?? envelope.code ?? 'unknown error'}`)
    }
    return envelope.data
  }
}
