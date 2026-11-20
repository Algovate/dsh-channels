/**
 * Turning one Feishu attachment descriptor into a file on disk.
 *
 * The adapter downloads through the resources endpoint, then lets
 * {@link resolveMediaType} decide the mime and extension from the bytes —
 * Feishu happily delivers a JPEG inside a file named `.webp`, and the host's
 * readers key off both. Failures are logged and reported as `undefined`; the
 * caller keeps the text and records a user-facing reason.
 *
 * @module @derekluo/dsh-channels-feishu/attachments
 */
import fs from 'node:fs'
import path from 'node:path'

import type { InboundMedia } from '@derekluo/dsh-channels'
import { resolveMediaType } from './media.js'
import type { RawMedia } from './normalize.js'
import type { FeishuTransport, TransportLogger } from './transport.js'

export interface AttachmentOptions {
  transport: FeishuTransport
  accountId: string
  /** Directory that owns every inbound file; empty disables saving. */
  mediaRoot: string
  maxInboundBytes: number
  logger: TransportLogger
}

/** A file name that is safe to write and keeps the extension Feishu implied. */
function safeName(name: string, fallback: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return base === '' ? fallback : base
}

/** Extension to try before sniffing, based on the kind and the name Feishu gave. */
function extensionFor(item: RawMedia): string {
  if (item.fileName !== undefined && path.extname(item.fileName) !== '') return path.extname(item.fileName)
  if (item.kind === 'image') return '.jpg'
  if (item.kind === 'video') return '.mp4'
  if (item.kind === 'voice') return '.ogg'
  return '.bin'
}

/** Download one attachment and write it under the account's media directory. */
export async function saveInboundAttachment(item: RawMedia, options: AttachmentOptions): Promise<InboundMedia | undefined> {
  const { transport, accountId, mediaRoot, maxInboundBytes, logger } = options
  const downloaded = await transport.downloadResource(item.messageId, item.fileKey, item.type, maxInboundBytes)
  if ('error' in downloaded) {
    logger.warn(`feishu ${item.kind} not downloaded: ${downloaded.error}`)
    return undefined
  }
  try {
    const resolved = resolveMediaType(downloaded.bytes, item.mime, item.fileName, extensionFor(item))
    const directory = path.join(mediaRoot, safeName(accountId, 'feishu'))
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${item.kind}${resolved.extension}`)
    fs.writeFileSync(file, downloaded.bytes, { mode: 0o600 })
    logger.info(`saved inbound ${item.kind} to ${file} (${downloaded.bytes.length} bytes, ${resolved.mime})`)
    return {
      kind: item.kind,
      path: file,
      mime: resolved.mime,
      bytes: downloaded.bytes.length,
      ...(item.fileName === undefined ? {} : { name: safeName(item.fileName, 'file') }),
    }
  } catch (error) {
    logger.warn(`feishu attachment could not be saved: ${String(error)}`)
    return undefined
  }
}
