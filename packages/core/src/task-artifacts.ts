/** Capture declared outputs and build a safe delivery plan without sending messages. */
import fs from 'node:fs'
import path from 'node:path'
import { copyDeliverable, describeArtifact, type ArtifactDelivery } from './artifacts.js'
import { localImageReferences } from './outbound.js'
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
  reply: Pick<TurnReply, 'text' | 'deliverables' | 'deliverablesIncomplete'>
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
    const artifacts: string[] = []
    let failed = Math.max(0, declared.length - maxFiles)
    for (const file of declared.slice(0, maxFiles)) {
      const captured = await copyDeliverable(path.resolve(workingDirectory, file.path), outputDirectory, maxBytes, workingDirectory)
      if (captured === undefined) failed++
      else artifacts.push(captured)
    }
    index = { outputDirectory, artifacts: artifacts.sort(), artifactsIncomplete: failed > 0 }
    if (failed > 0) {
      notices.push(`${failed} 个附件未发送（超过数量或大小限制、已改变或无法安全读取），请在 DSH 核对。`)
    }
  }

  if (reply.deliverablesIncomplete) {
    index.artifactsIncomplete = true
    notices.push('部分附件未发送：声明文件超过恢复数量上限，请在 DSH 核对。')
  }
  if (index.outputDirectory === undefined) return { index, attachments: [], notices }
  const directory = index.outputDirectory
  const files = [...new Set(index.artifacts ?? [])]
  const attachments: ArtifactDelivery[] = []
  let unavailable = Math.max(0, files.length - maxFiles)
  for (const relative of files.slice(0, maxFiles)) {
    const artifact = await describeArtifact(workingDirectory, directory, relative, maxBytes)
    if (artifact) attachments.push(artifact)
    else unavailable++
  }
  if (unavailable > 0) {
    index.artifactsIncomplete = true
    notices.push('部分附件未发送：文件超过数量或大小限制、已改变，或无法安全读取。请在 DSH 核对。')
  }
  return { index, attachments, notices }
}
