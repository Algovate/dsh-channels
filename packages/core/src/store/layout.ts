/**
 * Every file this plugin keeps on disk, declared in one place.
 *
 * The table is the authority: `doctor --state` and `/diag export` read it, and
 * a guard test fails when a module writes a top-level path the table does not
 * declare. Two fields, because they answer different questions: `kind` is what
 * it is on disk, `store` is what the storage migration intends.
 *
 * @module @rodin/dsh-channels/store/layout
 */
import path from 'node:path'

export const STORE = {
  /** Shadow-written to the storage domain now. */
  DOMAIN: 'domain',
  /** Named in the migration plan for a later phase. */
  PLANNED: 'planned',
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
  /** `memory/life-<account>.json`: a naming rule inside a directory, not one path. */
  pattern?: true
  contents?: string
}

export const STATE_LAYOUT: Readonly<Record<string, LayoutEntry>> = Object.freeze({
  accounts: { kind: 'dir', relative: 'openclaw-weixin', label: '通道凭证', store: STORE.FILE, reason: 'vendor 登录流程写的 token（0600）；换后端只会扩大泄露面', contents: 'accounts.json · accounts/<accountId>.json · accounts/<accountId>.sync.json' },
  registry: { kind: 'file', relative: 'registry.json', label: '绑定账号清单', store: STORE.PLANNED, reason: '账号注册表，第二阶段', },
  config: { kind: 'file', relative: 'config.json', label: '设置覆盖', store: STORE.PLANNED, reason: '设置覆盖，第二阶段（与凭证同目录，注意权限）' },
  sessions: { kind: 'file', relative: 'sessions.json', label: '会话线', store: STORE.PLANNED, reason: '会话线，第三阶段（坏了会答错人）' },
  sessionsUnused: { kind: 'dir', relative: 'workspace', label: 'Agent 工作目录', store: STORE.FILE, reason: 'Agent 的工具在这里写用户产物，不是 KV', contents: 'output/…' },
  outbox: { kind: 'file', relative: 'outbox.json', label: '待发队列', store: STORE.PLANNED, reason: '需要保序 + 原子批，第二阶段' },
  budget: { kind: 'file', relative: 'budget.json', label: '后台调用预算', store: STORE.DOMAIN, reason: '影子写 + 双读比对（channels_derived）' },
  senderDaily: { kind: 'file', relative: 'sender-daily.json', label: '每发送者每日配额', store: STORE.DOMAIN, reason: '影子写 + 双读比对（channels_derived）' },
  usageLedger: { kind: 'file', relative: 'usage-ledger.json', label: '用量账本', store: STORE.DOMAIN, reason: '影子写 + 双读比对（channels_derived）' },
  lifeState: { kind: 'file', relative: 'memory/life-<account>.json', label: '生活状态快照', store: STORE.DOMAIN, reason: '按账号一个文件', pattern: true },
  affinity: { kind: 'file', relative: 'memory/affinity-<account>-<conversation>.json', label: '关系日线', store: STORE.DOMAIN, reason: '按账号 + 会话', pattern: true },
  memoryDir: { kind: 'dir', relative: 'memory', label: '记忆', store: STORE.PLANNED, reason: '记忆，第四阶段（最后一批）', contents: 'global-<account>.json · conv-<account>-<conv>.json · index/' },
  memoryIndexDir: { kind: 'dir', relative: 'memory/index', label: '回忆索引', store: STORE.PLANNED, reason: '与记忆同批', contents: '<accountId>.json' },
  journalDir: { kind: 'dir', relative: 'journal', label: '消息流水', store: STORE.FILE, reason: 'append-only：按天追加 + grep + 导出；域是 KV，语义不合', contents: 'journal-YYYY-MM-DD.jsonl' },
  auditDir: { kind: 'dir', relative: 'audit', label: '工具审计', store: STORE.FILE, reason: 'append-only 审计链（带前一条哈希），域不保序', contents: 'audit-YYYY-MM-DD.jsonl' },
  mediaInboundDir: { kind: 'dir', relative: 'media/inbound', label: '收到的媒体', store: STORE.FILE, reason: '二进制，用户要能直接打开；大对象不进域' },
  logsDir: { kind: 'dir', relative: 'logs', label: '运行日志', store: STORE.FILE, reason: '诊断日志，按天追加', contents: 'channels-YYYY-MM-DD.log' },
  diagDir: { kind: 'dir', relative: 'diag', label: '体检包', store: STORE.FILE, reason: '导出的体检包，用户自己决定发给谁', contents: 'diag-<stamp>.md' },
  backupsDir: { kind: 'dir', relative: 'backups', label: '备份', store: STORE.FILE, reason: '备份不能依赖被备份的存储', contents: '<stamp>/' },
  instanceLock: { kind: 'file', relative: 'instance.lock', label: '实例锁', store: STORE.FILE, reason: '需要 PID + mtime 语义，跨进程' },
  loginQr: { kind: 'file', relative: 'login-qr.png', label: '登录二维码', store: STORE.FILE, reason: '扫码用的临时图片，过期即无用' },
})

/** Resolve one entry by key; a typo throws instead of writing somewhere new. */
export function statePath(root: string, key: string): string {
  const entry = STATE_LAYOUT[key]
  if (entry === undefined) throw new Error(`unknown state entry: ${key}`)
  if (entry.pattern === true) throw new Error(`state entry ${key} is a pattern, not a path: ${entry.relative}`)
  return path.join(path.resolve(root), entry.relative)
}

/** Every non-pattern entry, with its absolute path. */
export function statePaths(root: string): Record<string, LayoutEntry & { absolute: string }> {
  const base = path.resolve(root)
  const out: Record<string, LayoutEntry & { absolute: string }> = {}
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    if (entry.pattern === true) continue
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
