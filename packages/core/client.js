/**
 * The Chat row for a channel message.
 *
 * A WeChat message lands in its own session, and without this the transcript
 * shows it as a bare host bubble with no hint that it came from a phone. The
 * row marks it: a channel badge over the person's words, right aligned like the
 * host's own user bubble, using the host's tokens so light and dark both work.
 *
 * Two registrations make that happen and both are effects of the caller's
 * context (the returned disposer removes them):
 *   - a Chat target Definition (`exclusive`, so the assembler gives the message
 *     to this row instead of the generic user row) matching
 *     `source.kind === <channel>`;
 *   - a renderer in the keyed `conversation.chat.node` seat under that row's id.
 *
 * The channel table below is static on purpose and is the one seam worth
 * knowing about: the Client has no channel-list channel today (the host's
 * registrations are not visible to the browser), so a new adapter needs an
 * entry here — or a host remote that answers "which channels are mounted",
 * which is what the settings card will need anyway.
 */

window.__ModuleLoader__.load({
  id: '@rodin/dsh-channels',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The channels this row knows how to label. */
    const CHANNELS = [
      { id: 'weixin', row: 'weixin-user', badge: { en: 'WeChat', zh: '微信' }, accent: '#07C160', accentSoft: 'rgba(7, 193, 96, 0.12)' },
    ]

    const byKind = new Map(CHANNELS.map((channel) => [channel.id, channel]))

    /** Bilingual lookup without a locale round trip: the row ships two strings. */
    function translator() {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      const chinese = lang.startsWith('zh')
      return (en, zh) => (chinese ? zh : en)
    }

    /** A wxid is long and uniform; twelve characters are enough to tell people apart. */
    function shortSender(senderId) {
      const value = String(senderId ?? '')
      const at = value.indexOf('@')
      const name = at > 0 ? value.slice(0, at) : value
      return name.length > 12 ? `${name.slice(0, 12)}…` : name
    }

    /**
     * Renderer-ready data of one channel row.
     *
     * Built from the durable event only, and nothing here may throw: a malformed
     * event renders as an empty row instead of blanking the transcript.
     */
    function rowData(message) {
      const content = Array.isArray(message?.content) ? message.content : []
      const texts = []
      let others = 0
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block !== null && block !== undefined) others += 1
      }
      const source = message?.source ?? {}
      return {
        text: texts.join('\n').trim(),
        others,
        group: source.group === true,
        senderId: typeof source.senderId === 'string' ? source.senderId : '',
      }
    }

    /**
     * One durable `user/message` is one row, keyed by its message id.
     *
     * `exclusive` is what claims the message on the `chat` target: the assembler
     * evaluates every Definition before accepting any, so registration order
     * never decides this.
     */
    function definitionFor(channel) {
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
            // it visible as the opening input. Per-conversation FIFO means it is
            // never a mid-turn steer.
            groupTree: 'exchange',
            data: context.state,
          }
        },
      }
    }

    /**
     * The row itself: badge + sender meta over the person's words.
     *
     * The bubble geometry is copied from the host's own user bubble rather than
     * invented, so a WeChat message and a typed one sit in the transcript as the
     * same kind of object.
     */
    function createRow(channel, t) {
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

    /** Register the Definition and its renderer; returns the disposer for both. */
    function registerRows(ctx, uiConversation) {
      const t = translator()
      const disposers = []
      for (const channel of CHANNELS) {
        if (!byKind.has(channel.id)) continue
        const disposeDefinition = uiConversation.events.register(definitionFor(channel))
        let disposeSeat
        const seat = ctx.slots.inject('conversation.chat.node', () => {
          disposeSeat = ctx.slots.register({ name: 'conversation.chat.node', key: channel.row }, createRow(channel, t))
          return disposeSeat
        })
        disposers.push(() => {
          try {
            disposeSeat?.()
            seat?.()
          } finally {
            disposeDefinition?.()
          }
        })
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            console.warn('@rodin/dsh-channels: chat row teardown failed', error)
          }
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `uiConversation` is not in the module-level inject on purpose: a host
        // without the Conversation registry should lose the row, not keep the
        // whole client inactive. A reactive injection does exactly that.
        return ctx.inject(['uiConversation', 'slots'], (scope) => {
          try {
            return registerRows(scope, scope.uiConversation)
          } catch (error) {
            console.warn('@rodin/dsh-channels: chat row not registered', error)
            return () => {}
          }
        })
      },
    }
  },
})
