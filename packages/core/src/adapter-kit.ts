/**
 * Pure helpers shared by channel adapters.
 *
 * Every adapter saves inbound media under a generated name and needs the same
 * three decisions: is this string safe to use as a path segment, what extension
 * did the platform imply, and what extension is conventional for a kind when
 * it implied none. Keeping them here means the rules cannot drift per channel,
 * and adapters stay free to keep their platform-specific mime logic local.
 *
 * This module must stay dependency-free and side-effect-free so adapters can
 * import it from any runtime.
 *
 * @module @derekluo/dsh-channels/adapter-kit
 */

export type MediaKind = 'image' | 'file' | 'voice' | 'video'

/**
 * A string that is safe as one path segment.
 *
 * Only `[A-Za-z0-9._-]` survives, the result is capped at 80 characters, and
 * empty or traversal-only values become `fallback`. The extension is part of
 * the allowed set, so callers can keep it by passing the original name.
 */
export function safeFileSegment(value: string, fallback = 'attachment'): string {
  const safe = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return safe === '' || safe === '.' || safe === '..' ? fallback : safe
}

/** Lowercased extension (with the dot) from a name, or '' when absent/unreasonable. */
export function extensionOfName(name: string | undefined): string {
  if (typeof name !== 'string') return ''
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (extension.length <= 1 || extension.length > 9 || extension.includes('/')) return ''
  return extension
}

/**
 * The extension a media kind gets when the platform gave no usable name.
 * `voiceExtension` exists because WeChat's saved voice note is SILK, not Ogg.
 */
export function defaultExtensionFor(kind: MediaKind, voiceExtension = '.ogg'): string {
  switch (kind) {
    case 'image': return '.jpg'
    case 'video': return '.mp4'
    case 'voice': return voiceExtension
    case 'file': return '.bin'
  }
}
