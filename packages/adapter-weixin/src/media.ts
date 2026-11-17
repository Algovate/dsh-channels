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
 * @module @rodin/dsh-channels-weixin/media
 */
import fs from 'node:fs'
import path from 'node:path'

import { downloadMediaFromItem } from '../vendor/openclaw-weixin/media/media-download.js'
import { getMimeFromFilename, getExtensionFromMime } from '../vendor/openclaw-weixin/media/mime.js'
import { MessageItemType } from '../vendor/openclaw-weixin/api/types.js'
import type { InboundMedia } from '@rodin/dsh-channels'

/** iLink item type → the kind the core understands. */
const ITEM_KIND: Record<number, InboundMedia['kind'] | undefined> = {
  [MessageItemType.IMAGE]: 'image',
  [MessageItemType.VOICE]: 'voice',
  [MessageItemType.FILE]: 'file',
  [MessageItemType.VIDEO]: 'video',
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'attachment'
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
const KIND_EXTENSION: Record<InboundMedia['kind'], string> = {
  image: '.jpg',
  video: '.mp4',
  voice: '.silk',
  file: '.bin',
}

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
  const fromName = typeof originalName === 'string' ? path.extname(originalName).toLowerCase() : ''
  if (fromName !== '' && fromName.length <= 8) return fromName
  if (typeof mime === 'string' && EXTENSIONS[mime] !== undefined) return EXTENSIONS[mime]
  return KIND_EXTENSION[kind]
}

export interface InboundMediaOptions {
  accountId: string
  /** `<stateRoot>/media/inbound` */
  mediaRoot: string
  cdnBaseUrl: string
  messageId: string
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

  const directory = path.join(options.mediaRoot, safeName(options.accountId))
  fs.mkdirSync(directory, { recursive: true })
  const stamp = `${options.messageId}-${Date.now().toString(36)}`
  const saved: string[] = []
  let savedMime = 'application/octet-stream'

  const saveMedia = async (buffer: Buffer, mime?: string, _subdir?: string, _maxBytes?: number, originalName?: string): Promise<{ path: string }> => {
    const declared = typeof mime === 'string' && mime !== '' && mime !== 'application/octet-stream' ? mime : undefined
    const type = declared ?? sniffMime(buffer) ?? getMimeFromFilename(originalName ?? kind)
    savedMime = type
    const extension = extensionFor({ ...(declared === undefined ? {} : { mime: type }), kind, ...(originalName === undefined ? {} : { originalName }) })
    const base = originalName === undefined ? `${stamp}-${kind}${extension}` : `${stamp}-${safeName(originalName)}`
    const file = path.join(directory, base)
    await fs.promises.writeFile(file, buffer, { mode: 0o600 })
    saved.push(file)
    return { path: file }
  }

  try {
    const result = (await downloadMediaFromItem(item, {
      cdnBaseUrl: options.cdnBaseUrl,
      saveMedia,
      log: () => {},
      errLog: (line: string) => options.logger.warn(String(line).slice(0, 300)),
      label: 'weixin',
      mediaSubdir: 'inbound',
    })) as unknown
    const file = saved[0]
    if (file === undefined) return { ok: false, kind, reason: 'download-empty' }
    const bytes = fs.statSync(file).size
    const media: InboundMedia = {
      kind,
      path: file,
      mime: savedMime,
      bytes,
      ...(typeof item.file_item?.file_name === 'string' ? { name: safeName(item.file_item.file_name) } : {}),
    }
    options.logger.info(`saved inbound ${kind} to ${file} (${bytes} bytes)`)
    return { ok: true, media }
  } catch (error) {
    return { ok: false, kind, reason: String((error as Error)?.message ?? error) }
  }
}

/** How many attachments of one message this adapter will fetch. */
export const MAX_INBOUND_MEDIA = 8
