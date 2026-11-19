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
  stateLock: {
    kind: 'file',
    relative: 'state.lock',
    label: '单写者锁',
    store: STORE.FILE,
    reason: '一个状态根只允许一个进程写；持有者 pid 存活时拒绝读写，进程退出后可接管',
  },
  stateClaim: {
    kind: 'file', relative: 'state.claim', label: '状态锁领取互斥', store: STORE.FILE,
    reason: '独占创建以串行检查和领取 state.lock；中断遗留时拒绝启动，核对进程后人工清理',
  },
  state: {
    kind: 'file',
    relative: 'state.json',
    label: '统一状态文档',
    store: STORE.FILE,
    reason: 'v2 权威快照，原子替换；旧状态一次性迁移到 legacy-state 后不再双写',
  },
  legacyState: {
    kind: 'dir', relative: 'legacy-state', label: '旧状态迁移备份', store: STORE.FILE,
    reason: '统一状态成功提交后保存旧文件原始字节；不再参与运行时读取或写入',
    contents: '*.json.bak · state.v1.json.bak',
  },
  inbox: {
    kind: 'file',
    relative: 'inbox.json',
    label: '未开始的入站消息',
    store: STORE.FILE,
    reason: '旧版入站文件，启动时一次性迁移并归档；运行时只写 state.json',
  },
  tasks: {
    kind: 'file',
    relative: 'tasks.json',
    label: '每聊天最近任务状态',
    store: STORE.FILE,
    reason: '旧版任务文件，迁移后归档；任务摘要、恢复与产物索引在 state.json',
  },
  schedules: {
    kind: 'file', relative: 'schedules.json', label: '通道计划与结果回传', store: STORE.FILE,
    reason: '旧版计划文件，迁移后归档；归属、创建意图与进度在 state.json',
  },
  outbox: {
    kind: 'file',
    relative: 'outbox.json',
    label: '待重发队列',
    store: STORE.FILE,
    reason: '旧版投递文件，迁移后归档；文字与附件队列在 state.json，最多 50 项',
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
