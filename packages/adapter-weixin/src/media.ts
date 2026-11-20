/**
 * Inbound attachments: iLink item → a file on disk this machine can open.
 *
 * The vendored downloader does the transport work (CDN fetch, AES-128-ECB
 * decryption, SILK→WAV when `silk-wasm` is installed) and asks us where to put
 * the bytes. Everything lands under the plugin's own state root, one directory
 * per account, with a name that carries the message id so two attachments
 * cannot collide.
 *
 * Nothing here may fail a message: the person still said something in text, and
 * a photo that could not be fetched is reported as "could not be fetched".
 *
 * @module @derekluo/dsh-channels-weixin/media
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { downloadMediaFromItem } from '../vendor/openclaw-weixin/media/media-download.js'
import { getMimeFromFilename } from '../vendor/openclaw-weixin/media/mime.js'
import { MessageItemType } from '../vendor/openclaw-weixin/api/types.js'
import type { InboundMedia } from '@derekluo/dsh-channels'
import { defaultExtensionFor, extensionOfName, safeFileSegment } from '@derekluo/dsh-channels/adapter-kit'

/** iLink item type → the kind the core understands. */
const ITEM_KIND: Record<number, InboundMedia['kind'] | undefined> = {
  [MessageItemType.IMAGE]: 'image',
  [MessageItemType.VOICE]: 'voice',
  [MessageItemType.FILE]: 'file',
  [MessageItemType.VIDEO]: 'video',
}



/** MIME → extension, for the common kinds WeChat actually carries. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/wav': '.wav',
  'audio/silk': '.silk',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
}

/** Last-resort extension by kind, when the bytes are not recognisable either. */

/**
 * Read the real type from the first bytes.
 *
 * iLink does not send a content type for an image, and the vendored downloader
 * passes `undefined` — which used to land as `image.bin`. A `.bin` file is
 * refused by `read_image`, so the agent had to copy it to `.jpg` before it
 * could look at the photo (observed on the device). Sniffing costs four bytes
 * and removes that whole detour.
 */
export function sniffMime(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf'
  return undefined
}

/** The extension a saved inbound file should carry. */
export function extensionFor({ mime, kind, originalName }: { mime?: string; kind: InboundMedia['kind']; originalName?: string }): string {
  const fromName = extensionOfName(originalName)
  if (fromName !== '') return fromName
  if (typeof mime === 'string' && EXTENSIONS[mime] !== undefined) return EXTENSIONS[mime]
  return defaultExtensionFor(kind, '.silk')
}

export interface InboundMediaOptions {
  accountId: string
  /** `<stateRoot>/media/inbound` */
  mediaRoot: string
  cdnBaseUrl: string
  messageId: string
  signal?: AbortSignal
  maxBytes?: number
  logger: { info: (line: string) => void; warn: (line: string) => void }
}

/**
 * Save one item. Returns the saved file, or a reason when it could not be
 * fetched — the caller decides whether to mention it.
 */
export async function saveInboundItem(
  item: { type?: number; image_item?: unknown; voice_item?: unknown; file_item?: { file_name?: string }; video_item?: unknown },
  options: InboundMediaOptions,
): Promise<{ ok: true; media: InboundMedia } | { ok: false; kind: InboundMedia['kind']; reason: string }> {
  const kind = item?.type === undefined ? undefined : ITEM_KIND[item.type]
  if (kind === undefined) return { ok: false, kind: 'file', reason: 'unsupported-item' }

  const directory = path.join(options.mediaRoot, safeFileSegment(options.accountId))
  const stamp = `${safeFileSegment(options.messageId)}-${randomUUID()}`
  let media: InboundMedia | undefined

  const saveMedia = async (buffer: Buffer, mime?: string, _subdir?: string, maxBytes?: number, originalName?: string): Promise<{ path: string }> => {
    options.signal?.throwIfAborted()
    if (buffer.length > Math.min(maxBytes ?? MAX_INBOUND_MESSAGE_BYTES, options.maxBytes ?? MAX_INBOUND_MESSAGE_BYTES)) throw new Error(`attachment exceeds ${maxBytes} bytes`)
    const declared = typeof mime === 'string' && mime !== '' && mime !== 'application/octet-stream' ? mime : undefined
    const type = declared ?? sniffMime(buffer) ?? getMimeFromFilename(originalName ?? kind)
    const extension = extensionFor({ mime: type, kind, originalName })
    const base = originalName === undefined ? `${stamp}-${kind}${extension}` : `${stamp}-${safeFileSegment(originalName)}`
    const file = path.join(directory, base)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o600 })
    media = {
      kind,
      path: file,
      mime: type,
      bytes: buffer.length,
      ...(originalName === undefined ? {} : { name: safeFileSegment(originalName) }),
    }
    return { path: file }
  }

  let release: (() => void) | undefined
  try {
    release = await reserveMediaSlot(options.signal)
    await downloadMediaFromItem(item, {
      cdnBaseUrl: options.cdnBaseUrl,
      saveMedia,
      errLog: (line: string) => {
        if (options.signal?.aborted !== true) options.logger.warn(line.slice(0, 300))
      },
      label: 'weixin',
      mediaSubdir: 'inbound',
      signal: options.signal,
      maxBytes: options.maxBytes ?? MAX_INBOUND_MESSAGE_BYTES,
    })
    if (media === undefined) return { ok: false, kind, reason: 'download-empty' }
    options.logger.info(`saved inbound ${kind} to ${media.path} (${media.bytes} bytes)`)
    return { ok: true, media }
  } catch (error) {
    return { ok: false, kind, reason: String((error as Error)?.message ?? error) }
  } finally { release?.() }
}

/** How many attachments of one message this adapter will fetch. */
export const MAX_INBOUND_MEDIA = 8

/** Two 100 MiB downloads at most across all chats in this process. */
export const MAX_INBOUND_MESSAGE_BYTES = 100 * 1024 * 1024
let activeMedia = 0
const waitingMedia = new Set<() => void>()
function reserveMediaSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => { waitingMedia.delete(start); reject(signal?.reason ?? new Error('media download aborted')) }
    const start = () => {
      waitingMedia.delete(start)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(signal.reason); return }
      activeMedia++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        activeMedia--
        waitingMedia.values().next().value?.()
      })
    }
    if (signal?.aborted) { reject(signal.reason); return }
    if (activeMedia < 2) start()
    else { waitingMedia.add(start); signal?.addEventListener('abort', abort, { once: true }) }
  })
}
