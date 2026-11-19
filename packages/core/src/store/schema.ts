/**
 * The shape of every record this edge persists, declared once.
 *
 * These schemas replace the hand-written `validEntry` predicates the individual
 * stores used to carry. Schemastery is the schema library the host already
 * provides (and the core's config already uses), so records and config share one
 * validator instead of adding a second one.
 *
 * Each store only asks "is this safe to load/save?"; cross-record invariants
 * (unique ids, a notification's binding) stay in the store that owns them.
 *
 * @module @derekluo/dsh-channels/store/schema
 */
import z from '@deepseek-ai/schemastery'
import { MAX_PRODUCED_FILES } from '../media.js'
import type { OutboxEntry } from './outbox.js'

/** A nested object is only optional when it defaults to undefined (schemastery defaults objects to `{}`). */
const optional = <T>(schema: T): T => (schema as unknown as { default(value: undefined): T }).default(undefined)

const mediaKind = z.union([z.const('image'), z.const('file'), z.const('voice'), z.const('video')])

/** Fields every persisted inbound message must carry; adapter-owned context passes through. */
export const inboundMessageSchema = z.object({
  channel: z.string().required(),
  accountId: z.string().required(),
  conversationId: z.string().required(),
  senderId: z.string().required(),
  text: z.string().required(),
  group: z.boolean().required(),
  at: z.number().required(),
  media: z.array(z.object({
    kind: mediaKind.required(),
    path: z.string().required(),
    mime: z.string().required(),
    bytes: z.number().required(),
  })).required(),
  attachmentErrors: z.array(z.string()),
})

export const inboxEntrySchema = z.object({
  id: z.string().required(),
  message: inboundMessageSchema.required(),
  sessionId: z.string().required(),
  workingDirectory: z.string(),
  project: z.string(),
  clearedAt: z.number(),
})
export const inboxSchema = z.array(inboxEntrySchema)

const targetSchema = z.object({
  channel: z.string().required(),
  accountId: z.string().required(),
  conversationId: z.string().required(),
})

const turnProgressFields = {
  messageId: z.string().required(),
  lastSeq: z.number().min(-1).required(),
  activeTurn: z.natural(),
  matchingTurn: z.natural(),
  inboxIndex: z.natural(),
  cancelled: z.boolean().required(),
}
const turnProgressSchema = z.object({ ...turnProgressFields, text: z.string().max(16000).required() })
const recoveryProgressSchema = z.object({ ...turnProgressFields, text: z.string().required() })


export const taskSchema = z.object({
  id: z.string().required(),
  target: targetSchema.required(),
  senderId: z.string().required(),
  summary: z.string().required(),
  startedAt: z.number().required(),
  endedAt: z.number(),
  execution: z.union(['running', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'].map((value) => z.const(value))).required(),
  delivery: z.union(['none', 'sending', 'sent', 'pending', 'unknown', 'failed'].map((value) => z.const(value))).required(),
  unconfirmed: z.boolean(),
  filesUnsent: z.boolean(),
  workingDirectory: z.string(),
  project: z.string(),
  outputDirectory: z.string(),
  replyMessage: optional(inboundMessageSchema),
  artifacts: z.array(z.string()).max(MAX_PRODUCED_FILES),
  artifactsIncomplete: z.boolean(),
  recovery: optional(z.object({
    sessionId: z.string().required(),
    messageId: z.string().required(),
    beforeSeq: z.number().min(-1).required(),
    message: inboundMessageSchema.required(),
    project: z.string(),
    cursor: optional(z.object({
      progress: recoveryProgressSchema.required(),
      deliverables: z.array(z.object({ path: z.string().required() })).max(MAX_PRODUCED_FILES).required(),
      deliverablesIncomplete: z.boolean(),
    })),
  })),
})
export const tasksSchema = z.array(taskSchema)

const artifactDeliverySchema = z.object({
  relative: z.string().required(), name: z.string().required(), kind: mediaKind.required(),
  bytes: z.natural().min(1).required(), sha256: z.string().pattern(/^[a-f0-9]{64}$/).required(),
})

export const outboxEntrySchema = z.object({
  id: z.string().required(),
  taskId: z.string(),
  target: targetSchema.required(),
  outgoing: z.object({ kind: z.const('reply').required(), text: z.string(), artifact: optional(artifactDeliverySchema) }).required(),
  attempts: z.natural().required(),
  nextAt: z.number().required(),
  part: z.natural(),
  remaining: z.array(z.string()),
  lastCode: z.string(),
  unconfirmed: z.boolean(),
  attachments: z.array(artifactDeliverySchema).max(MAX_PRODUCED_FILES),
  includesArtifacts: z.boolean(),
  filesFailed: z.boolean(),
})
export const outboxSchema = z.array(outboxEntrySchema)

export function outboxInvariants(items: OutboxEntry[]): boolean {
  return items.every((entry) => {
    const text = entry.outgoing.text !== undefined
    const artifact = entry.outgoing.artifact !== undefined
    if (text === artifact || (text && entry.outgoing.text!.trim() === '')) return false
    const files = [...(entry.outgoing.artifact ? [entry.outgoing.artifact] : []), ...(entry.attachments ?? [])]
    if (files.length && (!entry.taskId || entry.includesArtifacts !== true)) return false
    return files.every((file) => !file.relative.includes('\\') && !file.relative.includes('\0')
      && file.relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
      && !file.name.includes('/') && !file.name.includes('\\'))
  })
}

export const pairingSchema = z.object({
  id: z.string().required(),
  channel: z.string().required(),
  accountId: z.string().required(),
  conversationId: z.string().required(),
  senderId: z.string().required(),
  text: z.string().required(),
  at: z.number().required(),
  lastNoticeAt: z.number().required(),
  attempts: z.natural().min(1).required(),
})
export const pairingsSchema = z.array(pairingSchema)

const sessionSelectionSchema = z.object({
  current: z.natural().required(),
  max: z.natural().required(),
})

export const chatRoutingSchema = z.object({
  project: z.string().required(),
  sessions: z.dict(sessionSelectionSchema).required(),
})

export const linesSchema = z.dict(z.union([z.natural(), chatRoutingSchema]))


export const scheduleBindingSchema = z.object({
  id: z.string().pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).required(),
  sessionId: z.string().required(),
  scheduleId: z.string().min(1),
  title: z.string().max(120).required(),
  message: inboundMessageSchema.required(),
  project: z.string().required(),
  workingDirectory: z.string().required(),
  createdAt: z.natural().required(),
  deleting: z.boolean(),
  cursor: z.natural().required(),
  handled: z.array(z.string()).max(200).required(),
  progress: optional(turnProgressSchema),
})

export const scheduleStateSchema = z.object({
  version: z.const(1).required(),
  bindings: z.array(scheduleBindingSchema).max(100).required(),
  pending: z.array(z.object({
    id: z.string().required(),
    bindingId: z.string().required(),
    text: z.string().max(17000).required(),
  })).max(1000).required(),
})

/** True when the value matches the schema; the caller keeps its own typed copy. */
export function conforms(schema: unknown, value: unknown): boolean {
  try {
    ;(schema as (value: unknown) => unknown)(value)
    return true
  } catch {
    return false
  }
}

/** Cross-record invariants a schedule state must satisfy beyond its shape. */
export function scheduleStateInvariants(state: { bindings: Array<{ id: string }>; pending: Array<{ id: string; bindingId: string }> }): boolean {
  if (new Set(state.bindings.map((item) => item.id)).size !== state.bindings.length) return false
  if (new Set(state.pending.map((item) => item.id)).size !== state.pending.length) return false
  return state.pending.every((item) => state.bindings.some((owner) => owner.id === item.bindingId))
}

/** A binding's session id is derived from its id, and bindings carry no media. */
export function bindingInvariants(binding: { id: string; sessionId: string; message: { media: unknown[] } }): boolean {
  return binding.sessionId === `chan-schedule-${binding.id}` && binding.message.media.length === 0
}

/** Validate every migration input before any section is acknowledged. */
export function stateSectionsValid(sections: unknown): boolean {
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) return false
  return Object.entries(sections).every(([section, value]) => {
    switch (section) {
      case 'inbox': return conforms(inboxSchema, value)
      case 'tasks': return conforms(tasksSchema, value)
      case 'lines': return conforms(linesSchema, value)
      case 'pairings': return conforms(pairingsSchema, value)
      case 'outbox': {
        const box = value as { schemaVersion?: unknown; items?: unknown } | null
        return box !== null && typeof box === 'object' && box.schemaVersion === 1 && Array.isArray(box.items)
          && conforms(outboxSchema, box.items) && outboxInvariants(box.items)
      }
      case 'schedules': {
        if (!conforms(scheduleStateSchema, value)) return false
        const state = value as { bindings: Array<{ id: string; sessionId: string; message: { media: unknown[] } }>; pending: Array<{ id: string; bindingId: string }> }
        return scheduleStateInvariants(state) && state.bindings.every(bindingInvariants)
      }
      case 'counters': return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((record) => typeof record === 'number' ? Number.isFinite(record) && record >= 0
          : record !== null && typeof record === 'object' && 'count' in record && typeof record.count === 'number' && Number.isFinite(record.count) && record.count >= 0
            && (!('windowStart' in record) || record.windowStart === undefined || (typeof record.windowStart === 'number' && Number.isFinite(record.windowStart))))
      default: return false
    }
  })
}
