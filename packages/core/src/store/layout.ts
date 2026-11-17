/**
 * Every path this plugin keeps under its state root, declared once.
 *
 * The table is the authority: `doctor` reads it, and a guard test fails the
 * build when a module writes a top-level path the table does not name. Two
 * fields per row: `kind` is what it is on disk, `store` says whether the host's
 * storage domain is the home (a file then exists only as the fallback for a host
 * without that domain).
 *
 * @module @derekluo/dsh-channels/store/layout
 */
import path from 'node:path'

export const STORE = {
  /** The storage domain is the home; the file is the fallback. */
  DOMAIN: 'domain',
  /** Never goes to the domain; `reason` says why. */
  FILE: 'file',
} as const

export type StoreTier = (typeof STORE)[keyof typeof STORE]

export interface LayoutEntry {
  kind: 'file' | 'dir'
  relative: string
  label: string
  store: StoreTier
  reason?: string
  contents?: string
}

export const STATE_LAYOUT: Readonly<Record<string, LayoutEntry>> = Object.freeze({
  config: {
    kind: 'file',
    relative: 'config.json',
    label: '设置覆盖',
    store: STORE.FILE,
    reason: '权限 0600 的小 JSON；卡片通过宿主的 HTTP 路由写它，覆盖加载器配置',
  },
  counters: {
    kind: 'file',
    relative: 'counters.json',
    label: '限流计数（回落）',
    store: STORE.DOMAIN,
    reason: '正常存宿主的 channels 存储域；这台宿主没有存储域时才落到这个文件',
  },
  lines: {
    kind: 'file',
    relative: 'lines.json',
    label: '会话线号',
    store: STORE.FILE,
    reason: '身份变更须原子保存成功后确认；旧 counters 的线号按需兼容读取',
  },
  outbox: {
    kind: 'file',
    relative: 'outbox.json',
    label: '待重发队列',
    store: STORE.FILE,
    reason: '需要保序的小队列，失败重发；条数上限 50，写入用原子替换',
  },
  journal: {
    kind: 'dir',
    relative: 'journal',
    label: '消息流水',
    store: STORE.FILE,
    reason: 'append-only：按天追加、grep 就能查；域是 KV，语义不合',
    contents: 'journal-YYYY-MM-DD.jsonl',
  },
  logs: {
    kind: 'dir',
    relative: 'logs',
    label: '运行日志',
    store: STORE.FILE,
    reason: '诊断日志，按天追加',
    contents: 'channels-YYYY-MM-DD.log',
  },
  mediaInbound: {
    kind: 'dir',
    relative: 'media/inbound',
    label: '收到的媒体',
    store: STORE.FILE,
    reason: '二进制大对象，用户要能直接打开；不进域',
    contents: '<account>/…',
  },
  asrModels: {
    kind: 'dir',
    relative: 'asr-models',
    label: '可选的语音转写模型',
    store: STORE.FILE,
    reason: '语音转写桥直接读取本地模型文件',
  },
  workspace: {
    kind: 'dir',
    relative: 'workspace',
    label: 'Agent 工作目录',
    store: STORE.FILE,
    reason: 'Agent 的工具在这里写用户产物，不是 KV；默认还会登记成 GUI 的工作区',
  },
  accounts: {
    kind: 'dir',
    relative: 'openclaw-weixin',
    label: '通道凭证',
    store: STORE.FILE,
    reason: 'vendored 登录流程写的 token（0600）；换后端只会扩大泄露面',
    contents: 'accounts.json · accounts/<accountId>.json · accounts/<accountId>.sync.json',
  },
})

/** Resolve one entry by key; a typo throws instead of writing somewhere new. */
export function statePath(root: string, key: string): string {
  const entry = STATE_LAYOUT[key]
  if (entry === undefined) throw new Error(`unknown state entry: ${key}`)
  return path.join(path.resolve(root), entry.relative)
}

/** Every entry, with its absolute path. */
export function statePaths(root: string): Record<string, LayoutEntry & { absolute: string }> {
  const base = path.resolve(root)
  const out: Record<string, LayoutEntry & { absolute: string }> = {}
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    out[key] = { ...entry, absolute: path.join(base, entry.relative) }
  }
  return out
}

/** A keyed file inside a directory entry, with the key sanitised. */
export function keyedStatePath(root: string, dirKey: string, name: string): string {
  const dir = statePath(root, dirKey)
  const safe = String(name).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 160)
  const full = path.join(dir, safe)
  if (isInsideStateRoot(root, full) !== true) throw new Error(`state path escaped the root: ${safe}`)
  return full
}

export function isInsideStateRoot(root: string, candidate: string): boolean {
  return path.resolve(candidate).startsWith(path.resolve(root) + path.sep)
}

/** First path segment of every declared entry; the guard test checks writes against it. */
export function declaredTopLevel(): Set<string> {
  const tops = new Set<string>()
  for (const entry of Object.values(STATE_LAYOUT)) tops.add(entry.relative.split('/')[0] as string)
  return tops
}
