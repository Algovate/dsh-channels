/**
 * What the agent is told about the attachments a message carried.
 *
 * A channel message is text plus files, but the model reads text: a photo is a
 * path it has to open, a voice note is a WAV (or an undeciperable SILK), a
 * document is a file it has to read. This module writes that sentence, and it
 * is deliberately explicit about what cannot be done (an audio file cannot be
 * "read" as text) so the model says "I can't listen to this" instead of
 * inventing what the person said.
 *
 * The person's own words stay at the end, as the last thing the model reads.
 *
 * @module @rodin/dsh-channels/media
 */
import type { InboundMedia, InboundMessage } from './types.js'

const KIND_LABEL: Record<InboundMedia['kind'], string> = {
  image: '图片',
  file: '文件',
  voice: '语音',
  video: '视频',
}

/** Bytes → `1.2k` / `3.4M`, matching the diagnostics elsewhere. */
export function formatBytes(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}k`
  return `${(value / 1024 / 1024).toFixed(1)}M`
}

function describeOne(item: InboundMedia): string {
  const label = KIND_LABEL[item.kind] ?? '附件'
  const size = formatBytes(item.bytes)
  const name = item.name === undefined || item.name === '' ? '' : `${item.name}, `
  const head = `[用户发送的${label}已保存到本地：${item.path}（${name}${size}）]`
  switch (item.kind) {
    case 'image':
      return `${head}\n请用 read_image 工具查看这个文件的内容。`
    case 'voice':
      if (typeof item.transcript === 'string') {
        if (item.transcript.trim() === '') {
          return `${head}\n【语音转写】本机语音识别没有识别出内容（可能是静音、音乐或环境噪音），请据此说明你没听清，不要臆测内容。`
        }
        return `${head}\n【语音转写】以下是识别结果，按用户原话处理：\n${item.transcript}`
      }
      return `${head}\n这是一段微信语音，已转成 WAV；请用 read 工具处理，无法读取音频就如实说明。`
    case 'video':
      return `${head}\n这是一个视频文件，无法直接读取内容；需要了解画面时请让用户描述或发截图。`
    default:
      return `${head}\n请用 read 工具读取这个文件的内容。`
  }
}

/**
 * The user-message text for one inbound message: attachments first, the
 * person's own words last. No media means the text comes back untouched.
 */
export function inboundTextWithMedia(message: Pick<InboundMessage, 'text' | 'media'>): string {
  const media = Array.isArray(message.media) ? message.media : []
  if (media.length === 0) return message.text
  const blocks = media.map(describeOne)
  if (typeof message.text === 'string' && message.text !== '') blocks.push(message.text)
  return blocks.join('\n\n')
}
