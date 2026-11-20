/**
 * Best-effort content typing for inbound Feishu resources.
 *
 * Feishu reports an image sent as a file as `message_type: "file"` with only a
 * `file_name`, and clients can upload a JPEG named `.webp`. Trusting the name
 * makes the model try the wrong reader (and users see "read failed, renaming").
 * Sniffing a few magic bytes fixes the mime and the on-disk extension, which is
 * what the host's document/image readers key off.
 *
 * @module @derekluo/dsh-channels-feishu/media
 */
export interface SniffedMedia {
  mime: string
  /** Extension including the leading dot, e.g. ".jpg". */
  extension: string
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let index = 0; index < length && offset + index < bytes.length; index++) out += String.fromCharCode(bytes[offset + index]!)
  return out
}

/** Detect common image/document/audio/video types from their leading bytes. */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', extension: '.jpg' }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', extension: '.png' }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', extension: '.gif' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { mime: 'image/webp', extension: '.webp' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return { mime: 'audio/wav', extension: '.wav' }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { mime: 'application/pdf', extension: '.pdf' }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return { mime: 'audio/ogg', extension: '.ogg' }
  if (ascii(bytes, 0, 4) === 'fLaC') return { mime: 'audio/flac', extension: '.flac' }
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || startsWith(bytes, [0xff, 0xfb])) return { mime: 'audio/mpeg', extension: '.mp3' }
  if (ascii(bytes, 4, 4) === 'ftyp') return detectIsoBmff(bytes)
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { mime: 'application/zip', extension: '.zip' }
  return undefined
}

/** ISO base media files (mp4/mov/m4a) share `ftyp`; the brand distinguishes them. */
function detectIsoBmff(bytes: Uint8Array): SniffedMedia {
  const brand = ascii(bytes, 8, 4)
  if (brand === 'M4A ') return { mime: 'audio/mp4', extension: '.m4a' }
  if (brand === 'qt  ') return { mime: 'video/quicktime', extension: '.mov' }
  return { mime: 'video/mp4', extension: '.mp4' }
}

/**
 * Use the sniffed type when it is a real match; otherwise keep the platform's
 * declared mime and the extension the name implied.
 */
export function resolveMediaType(bytes: Uint8Array, declaredMime: string | undefined, fileName: string | undefined, fallbackExtension: string): SniffedMedia {
  const sniffed = sniffMedia(bytes)
  if (sniffed !== undefined) {
    // Trust bytes over a misleading name or the generic octet-stream default.
    return sniffed
  }
  if (bytes.length > 0 && isProbablyText(bytes) && /\.(md|markdown|txt|json|csv|log|ya?ml|xml|html?|ts|js|py|sh|toml|ini|cfg)$/i.test(fileName ?? '')) {
    return { mime: 'text/plain', extension: fallbackExtension || textExtension(fileName) }
  }
  return { mime: declaredMime ?? 'application/octet-stream', extension: fallbackExtension }
}

function textExtension(fileName: string | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '')
  return match === null ? '.txt' : `.${match[1]!.toLowerCase()}`
}

/** A conservative text check: no NUL bytes and valid UTF-8-ish bytes. */
function isProbablyText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096)
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return false
  return true
}
