/** Task-scoped artifact capture and retrieval; never accept a user-supplied retrieval path. */
import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { copyBounded } from './file-copy.js'
import { chatParagraphs } from './outbound.js'
import { formatBytes } from './media.js'
import type { TaskRecord, Tasks } from './store/tasks.js'
import type { InboundMessage, Outgoing, OutgoingMedia, SendResult } from './types.js'

interface ArtifactFile { path: string; name: string; bytes: number; dev: number; ino: number }

/** Check every component again: artifacts may have been deleted or replaced since execution. */
async function artifactFile(workspace: string, task: Pick<TaskRecord, 'outputDirectory'>, relative: string): Promise<ArtifactFile | undefined> {
  if (task.outputDirectory === undefined || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) return undefined
  const parts = relative.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  const directory = path.resolve(task.outputDirectory)
  if (path.dirname(directory) !== path.resolve(workspace) || !path.basename(directory).startsWith('.channel-output-')) return undefined
  try {
    if (!(await fs.lstat(directory)).isDirectory()) return undefined
    const base = await fs.realpath(workspace)
    if (path.dirname(await fs.realpath(directory)) !== base) return undefined
    let current = directory
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part)
      const stat = await fs.lstat(current)
      if (index < parts.length - 1) { if (!stat.isDirectory()) return undefined }
      else {
        if (!stat.isFile()) return undefined
        return { path: current, name: relative, bytes: stat.size, dev: stat.dev, ino: stat.ino }
      }
    }
  } catch { /* Missing, unreadable and replaced files have the same unavailable result. */ }
  return undefined
}

/** Adapters may wait before reading. Upload a private bounded copy from the verified descriptor. */
async function snapshotFile(file: ArtifactFile, maxBytes: number): Promise<{ path: string; dispose: () => Promise<void> }> {
  const source = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let temporary: string | undefined
  try {
    const stat = await source.stat()
    if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino || stat.size === 0 || stat.size > maxBytes) throw new Error('artifact changed')
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artifact-'))
    const copy = path.join(temporary, path.basename(file.name))
    const destination = await fs.open(copy, 'wx', 0o600)
    try {
      await copyBounded(source, destination, maxBytes)
    } finally { await destination.close() }
    const directory = temporary
    return { path: copy, dispose: () => fs.rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    if (temporary !== undefined) await fs.rm(temporary, { recursive: true, force: true })
    throw error
  } finally { await source.close() }
}

/** Copy one host-declared deliverable into the task's artifact directory. */
export async function copyDeliverable(source: string, directory: string, maxBytes: number, root?: string): Promise<string | undefined> {
  let expected
  try {
    expected = await fs.lstat(source)
    if (!expected.isFile()) return undefined
  } catch { return undefined }
  let actual = source
  if (root !== undefined) {
    try {
      const base = await fs.realpath(root)
      actual = await fs.realpath(source)
      const relative = path.relative(base, actual)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    } catch {
      return undefined
    }
  }
  let sourceFile
  try {
    sourceFile = await fs.open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  let destination: Awaited<ReturnType<typeof fs.open>> | undefined
  let name: string | undefined
  let complete = false
  try {
    const stat = await sourceFile.stat()
    // O_NOFOLLOW guards only the leaf; inode identity also detects a swapped parent.
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size <= 0 || stat.size > maxBytes) return undefined
    const base = (path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'deliverable').slice(0, 120)
    const safe = base === '' || base === '.' || base === '..' ? 'deliverable' : base
    const extension = path.extname(safe)
    const stem = path.basename(safe, extension)
    for (let index = 1; index <= 999; index += 1) {
      const candidate = index === 1 ? safe : `${stem}-${index}${extension}`
      try {
        destination = await fs.open(path.join(directory, candidate), 'wx', 0o600)
        name = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      }
    }
    if (destination === undefined || name === undefined) return undefined
    await copyBounded(sourceFile, destination, maxBytes)
    complete = true
    return name
  } catch {
    return undefined
  } finally {
    try { await destination?.close() } catch { /* Nothing to close. */ }
    try { await sourceFile.close() } catch { /* Nothing to close. */ }
    if (!complete && name !== undefined) await fs.rm(path.join(directory, name), { force: true }).catch(() => {})
  }
}

/** The automatic and manual delivery paths share containment checks and private upload bytes. */
export async function snapshotArtifact(workspace: string, outputDirectory: string, relative: string, maxBytes: number): Promise<{ path: string; dispose: () => Promise<void> } | undefined> {
  const file = await artifactFile(workspace, { outputDirectory }, relative)
  if (file === undefined) return undefined
  try { return await snapshotFile(file, maxBytes) } catch { return undefined }
}

export function mediaKind(name: string): OutgoingMedia['kind'] {
  const ext = path.extname(name).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video'
  return 'file'
}

export interface ArtifactDelivery {
  relative: string
  name: string
  kind: OutgoingMedia['kind']
  bytes: number
  sha256: string
}

async function fingerprint(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk) }
  return { bytes, sha256: hash.digest('hex') }
}

/** Retain the identity of exactly the bytes approved for automatic delivery. */
export async function describeArtifact(workspace: string, directory: string, relative: string, maxBytes: number): Promise<ArtifactDelivery | undefined> {
  const copy = await snapshotArtifact(workspace, directory, relative, maxBytes)
  if (!copy) return undefined
  try { return { relative, name: path.basename(relative), kind: mediaKind(relative), ...await fingerprint(copy.path) } }
  finally { await copy.dispose() }
}

/** A later retry may upload only the original planned bytes, from a private copy. */
export async function snapshotDelivery(workspace: string, directory: string, artifact: ArtifactDelivery, maxBytes: number): Promise<{ path: string; dispose: () => Promise<void> } | undefined> {
  const copy = await snapshotArtifact(workspace, directory, artifact.relative, maxBytes)
  if (!copy) return undefined
  try {
    const current = await fingerprint(copy.path)
    if (current.bytes === artifact.bytes && current.sha256 === artifact.sha256) return copy
  } catch { /* An unreadable snapshot is not safe to upload. */ }
  await copy.dispose()
  return undefined
}

export async function answerArtifactCommand({ message, name, args, tasks, workspace, workspaceFor, maxBytes, authorized, send }: {
  message: InboundMessage
  name: 'files' | 'resend'
  args: string
  tasks: Tasks
  workspace: string
  workspaceFor?: (task: TaskRecord) => string | undefined
  maxBytes: number
  authorized: () => boolean
  send: (outgoing: Outgoing) => Promise<readonly SendResult[]>
}): Promise<void> {
  const notice = async (text: string): Promise<void> => { if (authorized()) await send({ kind: 'notice', text }) }
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length > (name === 'files' ? 1 : 2) || (name === 'resend' && words.length === 0)) {
    await notice('用法：/files [任务ID]；/resend <任务ID> [文件序号]。任务ID可从 /tasks 获取。')
    return
  }
  const prefix = words[0]?.replace(/^#/, '').toLowerCase()
  if (prefix !== undefined && !/^[a-z0-9-]{8,80}$/.test(prefix)) { await notice('任务ID至少需要 8 个字符，请从 /tasks 复制。'); return }
  const visible = tasks.forTarget(message, message.group ? message.senderId : undefined)
  const matches = prefix === undefined
    ? visible.filter((task) => task.execution === 'completed').slice(-1)
    : visible.filter((task) => task.id.toLowerCase().startsWith(prefix))
  if (matches.length === 0) { await notice('未找到当前聊天中可取回的任务。请用 /tasks 查看任务ID。'); return }
  if (matches.length > 1) { await notice(chatParagraphs('任务ID不唯一，请使用其中一个完整任务ID：', ...matches.map((task) => task.id))); return }
  const task = matches[0]!
  if (task.execution !== 'completed' || task.delivery === 'sending') { await notice('任务尚未完成交付处理，请稍后再查看产物。'); return }
  if (task.outputDirectory === undefined || task.artifacts === undefined || task.artifacts.length === 0) {
    await notice('这项任务没有记录可取回的产物。旧版本任务可能未记录产物，请在 DSH 查看。')
    return
  }
  const directory = workspaceFor === undefined ? workspace : workspaceFor(task)
  if (directory === undefined) { await notice('任务所属项目已移除或目录已更改，请在 DSH 取回文件。'); return }
  if (name === 'files') {
    const rows = await Promise.all(task.artifacts.map(async (relative, index) => {
      const file = await artifactFile(directory, task, relative)
      return file === undefined ? `${index + 1}. 文件不可用（已删除、移动或无法安全读取）`
        : `${index + 1}. ${file.name.replace(/[\r\n\t]/g, ' ')}（${formatBytes(file.bytes)}${file.bytes > maxBytes ? '，超过发送大小上限' : ''}）`
    }))
    await notice(chatParagraphs(`【任务产物 #${task.id.slice(0, 8)}】`, ...rows, task.artifactsIncomplete ? '产物索引可能不完整，其余文件请在 DSH 查看。' : '', `重发：/resend ${task.id.slice(0, 8)} <文件序号>`))
    return
  }
  const index = words[1] ?? '1'
  if (!/^[1-9]\d{0,2}$/.test(index) || Number(index) > task.artifacts.length) { await notice('文件序号无效，请先用 /files <任务ID> 查看。'); return }
  const file = await artifactFile(directory, task, task.artifacts[Number(index) - 1]!)
  if (file === undefined) { await notice('文件不可用，可能已删除、移动或无法安全读取。请在 DSH 查看。'); return }
  if (file.bytes === 0 || file.bytes > maxBytes) { await notice('文件为空或超过发送大小上限，请在 DSH 取回。'); return }
  const copy = await snapshotArtifact(directory, task.outputDirectory, task.artifacts[Number(index) - 1]!, maxBytes)
  if (copy === undefined) { await notice('文件不可用或已改变，请重新查看产物后再试。'); return }
  let results: readonly SendResult[]
  try {
    if (!authorized()) return
    results = await send({ kind: 'reply', media: [{ kind: mediaKind(file.path), path: copy.path, name: path.basename(file.name) }] })
  } finally { await copy.dispose() }
  await notice(results.length === 0 || results.some((result) => !result.ok)
    ? '重发失败，文件仍保留在 DSH。可稍后再试。'
    : results.some((result) => result.ok && result.unconfirmed)
      ? '平台已接收重发请求，但投递尚未确认。'
      : '文件已发送。')
}
