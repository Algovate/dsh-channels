/** Capture declared outputs and build a safe delivery plan without sending messages. */
import fs from 'node:fs'
import path from 'node:path'
import { captureArtifacts, copyDeliverable, describeArtifact, type ArtifactDelivery } from './artifacts.js'
import { localImageReferences } from './outbound.js'
import { scanProducedFiles } from './produced.js'
import type { TaskRecord } from './store/tasks.js'
import type { TurnReply } from './turns.js'

export type TaskArtifactIndex = Pick<TaskRecord, 'outputDirectory' | 'artifacts' | 'artifactsIncomplete'>
export interface TaskArtifactPlan {
  index: TaskArtifactIndex
  attachments: ArtifactDelivery[]
  notices: string[]
}

function createTaskOutputDirectory(workingDirectory: string): string {
  const workspace = path.resolve(workingDirectory)
  fs.mkdirSync(workspace, { recursive: true })
  return fs.mkdtempSync(path.join(workspace, '.channel-output-'))
}

/** Existing indexes win during recovery: never recopy a later changed source. */
export async function prepareTaskArtifacts({ record, reply, workingDirectory, maxFiles, maxBytes }: {
  record: TaskArtifactIndex
  reply: Pick<TurnReply, 'text' | 'deliverables'>
  workingDirectory: string
  maxFiles: number
  maxBytes: number
}): Promise<TaskArtifactPlan> {
  const declared = [...new Map([...(reply.deliverables ?? []), ...localImageReferences(reply.text)]
    .map((file) => [path.resolve(workingDirectory, file.path), file])).values()]
  const notices: string[] = []
  let index: TaskArtifactIndex = {}
  if (record.outputDirectory !== undefined && record.artifacts !== undefined) index = { ...record }
  else if (declared.length) {
    let outputDirectory: string
    try { outputDirectory = createTaskOutputDirectory(workingDirectory) }
    catch { return { index: { artifactsIncomplete: true }, attachments: [], notices: ['附件未发送：无法创建产物目录，请在 DSH 核对。'] } }
    let failed = Math.max(0, declared.length - maxFiles)
    for (const file of declared.slice(0, maxFiles)) {
      if (await copyDeliverable(path.resolve(workingDirectory, file.path), outputDirectory, maxBytes, workingDirectory) === undefined) failed++
    }
    index = await captureArtifacts(outputDirectory, { includeAll: true })
    if (failed > 0) {
      index.artifactsIncomplete = true
      notices.push(`${failed} 个附件未发送（超过数量或大小限制、已改变或无法安全读取），请在 DSH 核对。`)
    }
  }

  if (index.outputDirectory === undefined) return { index, attachments: [], notices }
  const directory = index.outputDirectory
  const scan = await scanProducedFiles({ dir: directory, sinceMs: 0, maxFiles, maxBytes, ...(declared.length ? { includeAll: true } : {}) })
  const attachments: ArtifactDelivery[] = []
  const found = new Set(scan.files.map((file) => path.relative(directory, file.path)))
  let unavailable = (index.artifacts ?? []).filter((relative) => !found.has(relative)).length
  for (const file of scan.files) {
    const relative = path.relative(directory, file.path)
    const artifact = index.artifacts?.includes(relative) ? await describeArtifact(path.dirname(directory), directory, relative, maxBytes) : undefined
    if (artifact) attachments.push(artifact)
    else unavailable++
  }
  if (unavailable > 0 || scan.skipped > 0 || scan.incomplete) {
    index.artifactsIncomplete = true
    notices.push('部分附件未发送：文件超过数量或大小限制、已改变，或输出目录无法完整读取。请在 DSH 核对。')
  }
  return { index, attachments, notices }
}
