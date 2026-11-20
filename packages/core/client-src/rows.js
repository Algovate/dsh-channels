/**
 * The chat row for one channel message.
 *
 * `exclusive` claims the message on the `chat` target: the assembler evaluates
 * every Definition before accepting any, so registration order never decides.
 */
export function definitionFor(channel) {
  return {
    kind: channel.row,
    target: 'chat',
    match: (event) => {
      if (event?.type !== 'user/message') return null
      if (event.data?.source?.kind !== channel.id) return null
      return { id: String(event.data.id), role: 'start', exclusive: true }
    },
    start: (_context, match) => rowData(match.event.data),
    // One message is one start; a second start for the same id keeps the
    // earliest state rather than inventing a merge.
    update: (context) => context.state,
    buildViewNode: (context) => {
      if (context.state === undefined) return null
      const start = context.start ?? context.matches[0]
      return {
        key: context.key,
        kind: channel.row,
        id: context.id,
        target: 'chat',
        anchorSeq: start?.event?.seq ?? 0,
        location: start?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        // A channel message opens an exchange; whole-Turn folding has to keep
        // it visible as the opening input.
        groupTree: 'exchange',
        data: context.state,
      }
    },
  }
}

import { rowData, shortSender } from './channels.js'

/**
 * The row itself: badge + sender meta over the person's words.
 *
 * The bubble geometry is copied from the host's own user bubble rather than
 * invented, so a channel message and a typed one look like the same object.
 */
export function createRow(channel, t, h) {
  const metaStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    lineHeight: '16px',
    color: 'var(--dsw-label-tertiary, rgba(128, 128, 128, 0.9))',
  }
  const badgeStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 6px',
    borderRadius: 999,
    background: channel.accentSoft,
    color: channel.accent,
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 600,
  }
  const bubbleStyle = {
    maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)',
    padding: '10px 16px',
    borderRadius: 'var(--dsw-radius-xl, 20px)',
    background: 'var(--dsw-specific-bubble, rgba(128, 128, 128, 0.12))',
    color: 'var(--dsw-label-primary, inherit)',
    fontSize: 'var(--dsh-content-font-size, 14px)',
    lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }
  return function ChannelRowView({ node }) {
    const data = node?.data ?? {}
    const text = typeof data.text === 'string' ? data.text : ''
    const meta = []
    if (data.group === true) meta.push(t('Group', '群聊'))
    if (typeof data.senderId === 'string' && data.senderId !== '') meta.push(shortSender(data.senderId))
    if (Number(data.others) > 0) meta.push(t(`${data.others} attachment(s)`, `${data.others} 个附件`))
    return h(
      'div',
      { 'data-channels-chat-row': channel.id, style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } },
      h(
        'div',
        { style: metaStyle },
        h('span', { style: badgeStyle }, t(channel.badge.en, channel.badge.zh)),
        meta.length > 0 ? h('span', null, meta.join(' · ')) : null,
      ),
      h('div', { style: bubbleStyle }, text === '' ? t('(empty message)', '（空消息）') : text),
    )
  }
}
