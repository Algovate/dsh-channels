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
  id: '@derekluo/dsh-channels',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The package id the loader and the plugin page key off. */
    const PKG = '@derekluo/dsh-channels'

    /** The channels this row knows how to label. */
    const CHANNELS = [
      { id: 'weixin', row: 'weixin-user', badge: { en: 'WeChat', zh: '微信' }, accent: '#07C160', accentSoft: 'rgba(7, 193, 96, 0.12)' },
      { id: 'telegram', row: 'telegram-user', badge: { en: 'Telegram', zh: '电报' }, accent: '#2AABEE', accentSoft: 'rgba(42, 171, 238, 0.12)' },
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
      const source = message?.source ?? {}
      const blocks = Array.isArray(message?.content) ? message.content : []
      const content = source.hasOutputInstruction === true ? blocks.slice(1) : blocks
      const texts = []
      let others = 0
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block !== null && block !== undefined) others += 1
      }
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


    //#region status card

    /**
     * The plugin's page in Plugins → this bundle.
     *
     * Everything it shows comes from the host's `channels.status()` Remote: the
     * browser cannot read a config file or a journal, and a card of static prose
     * would be worse than no card. The first paint is a placeholder, the fetch
     * happens once on mount, and a failure is rendered where the table would be
     * rather than blanking the page.
     */
    function createCard(t) {
      const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
      const cell = { padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.2))', fontSize: 13, verticalAlign: 'top' }
      const headCell = { ...cell, fontSize: 12, fontWeight: 600, color: 'var(--dsw-label-secondary, rgba(128,128,128,1))' }
      const cardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 20,
        borderRadius: 'var(--dsw-radius-l, 14px)',
        background: 'var(--dsw-alias-panel, rgba(128,128,128,0.06))',
        color: 'var(--dsw-alias-label, inherit)',
      }
      const row = (cells) => h('tr', null, ...cells.map((value, index) => h('td', { key: index, style: cell }, value)))
      const stateColor = (state) => (state === 'accepted' ? '#2f9e44' : state === 'pending' ? '#b08900' : state === 'unconfirmed' ? '#b08900' : '#c92a2a')

      return function ChannelsStatusCard() {
        const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' })
        const load = React.useCallback(() => {
          setState((current) => ({ ...current, phase: 'loading', error: '' }))
          const fail = (error) => setState({ phase: 'error', data: null, error: String((error && error.message) || error) })
          const accept = (payload) => setState({ phase: 'ready', data: payload, error: '' })
          fetch('/channels/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
            .then((response) => {
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
              return response.json()
            })
            .then(accept, fail)
        }, [])
        React.useEffect(() => {
          load()
        }, [load])

        const data = state.data
        return h(
          'div',
          { 'data-channels-card': '', style: cardStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('Channels', '通道')),
              h('div', { style: { fontSize: 12, color: 'var(--dsw-label-secondary, rgba(128,128,128,1))' } },
                t('Messages from a chat app, answered by this agent.', '来自聊天软件的消息，由这个 agent 来回答。')),
            ),
            h('button', {
              type: 'button',
              onClick: load,
              style: {
                padding: '6px 12px',
                borderRadius: 'var(--dsw-radius-m, 10px)',
                border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))',
                background: 'transparent',
                color: 'inherit',
                fontSize: 13,
                cursor: 'pointer',
              },
            }, state.phase === 'loading' ? t('Refreshing…', '刷新中…') : t('Refresh', '刷新')),
          ),
          state.phase === 'error'
            ? h('div', { 'data-channels-card-error': '', style: { color: '#c92a2a', fontSize: 13 } }, state.error)
            : null,
          data === null && state.phase !== 'error'
            ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, t('Loading…', '加载中…'))
            : null,
          data !== null
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                h('div', { style: { fontSize: 12, opacity: 0.75 } }, `${t('State', '状态目录')}: ${text(data.stateRoot, '—')}`),
                h(
                  'table',
                  { style: { width: '100%', borderCollapse: 'collapse' } },
                  h('thead', null,
                    h('tr', null,
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('Channel', '通道')),
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('Account', '账号')),
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('Allowed senders', '允许的发送者')),
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('Media', '媒体')),
                    ),
                  ),
                  h('tbody', null,
                    (data.channels || []).map((channel) => h('tr', { key: channel.id },
                      h('td', { style: cell }, text(channel.label && channel.label.zh, channel.id)),
                      h('td', { style: cell }, (channel.accounts || []).map((account) => `${account.label || account.accountId}${account.expired ? t(' (expired)', '（已过期）') : ''}`).join(' · ') || '—'),
                      h('td', { style: cell }, (channel.accounts || []).map((account) => `${account.accountId}: ${account.allowedSenders}`).join(' · ') || '—'),
                      h('td', { style: cell }, ['image', 'file', 'voice', 'video'].filter((kind) => channel.media && channel.media[kind]).join(' · ') || '—'),
                    )),
                    (data.channels || []).length === 0
                      ? h('tr', null, h('td', { colSpan: 4, style: { ...cell, opacity: 0.7 } }, t('No channel is mounted.', '没有挂载任何通道。')))
                      : null,
                  ),
                ),
                h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, opacity: 0.85 } },
                  h('span', null, `${t('Queued inputs', '排队输入')}: ${Number(data.inboxPending) || 0}`),
                  h('span', null, `${t('Outbox', '待重发')}: ${Number(data.outboxPending) || 0}`),
                  h('span', null, `${t('Waiting for an answer', '等待答复')}: ${data.interactions && data.interactions.pending ? t('yes', '有') : t('no', '无')}`),
                ),
                h(PendingPairings, { data, reload: load, t }),
                h(AllowlistEditor, { data, reload: load, t }),
                h(SettingsEditor, { data, reload: load, t }),
                (data.journal || []).length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t('Recent outbound', '最近的发出')),
                      ...data.journal.map((entry, index) => h('div', {
                        key: `${entry.kind}-${index}`,
                        style: { display: 'flex', gap: 10, fontSize: 12, alignItems: 'baseline' },
                      },
                        h('span', { style: { color: stateColor(entry.state), minWidth: 84 } }, String(entry.state)),
                        h('span', { style: { opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text(entry.text, '—')),
                      )),
                    )
                  : h('div', { style: { fontSize: 12, opacity: 0.7 } }, t('Nothing has been sent yet.', '还没有发出过消息。')),
              )
            : null,
        )
      }
    }


    /**
     * Pending senders, approved here instead of by copying an id out of a log.
     */
    function PendingPairings({ data, reload, t }) {
      const list = Array.isArray(data.pairings) ? data.pairings : []
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      if (list.length === 0) return null
      const act = (id, action) => {
        setBusy(id)
        setError('')
        fetch('/channels/pairing', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ id, action }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok !== true) throw new Error(body.detail || `${response.status} ${response.statusText}`)
            reload()
          })
          .catch((cause) => setError(String((cause && cause.message) || cause)))
          .finally(() => setBusy(''))
      }
      const button = (id, action, label, danger) => h('button', {
        type: 'button',
        disabled: busy === id,
        'data-channels-pairing': action,
        onClick: () => act(id, action),
        style: {
          padding: '4px 10px',
          borderRadius: 8,
          border: `1px solid ${danger ? 'rgba(201,42,42,0.5)' : 'var(--dsw-alias-divider, rgba(128,128,128,0.3))'}`,
          background: 'transparent',
          color: danger ? '#c92a2a' : 'inherit',
          fontSize: 12,
          cursor: busy === id ? 'default' : 'pointer',
          opacity: busy === id ? 0.5 : 1,
        },
      }, label)
      return h(
        'div',
        { 'data-channels-pairings': '', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t('Pending senders', '待批准的发送者')),
        h('div', { style: { fontSize: 12, opacity: 0.75 } }, t('Approve the people you trust. Everyone else stays refused.', '只批准你信任的人；其余发送者继续被拒绝。')),
        ...list.map((pairing) => h(
          'div',
          { key: pairing.id, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 } },
          h('span', { style: { fontWeight: 600 } }, `${pairing.channel} · ${pairing.accountId}`),
          h('span', { style: { opacity: 0.85 } }, pairing.senderId),
          h('span', { style: { opacity: 0.6, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pairing.text || t('(attachment)', '（附件）')),
          button(pairing.id, 'approve', t('Allow', '允许'), false),
          button(pairing.id, 'deny', t('Deny', '拒绝'), true),
        )),
        error !== '' ? h('div', { 'data-channels-pairings-error': '', style: { color: '#c92a2a', fontSize: 12 } }, error) : null,
      )
    }

    /**
     * The allowlist editor.
     *
     * Deny-by-default only works if adding the first stranger is easy, and
     * hand-editing `config.json` is not easy. The write goes to the Host's own
     * route (`POST /channels/allowlist`), which updates the live gate and the
     * overlay together, so the next message from that sender is accepted
     * without a restart.
     */
    function AllowlistEditor({ data, reload, t }) {
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const list = Array.isArray(data.allowlist) ? data.allowlist : []

      const send = (patch) => {
        setBusy(true)
        setError('')
        fetch('/channels/allowlist', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok !== true) throw new Error(body.detail || `${response.status} ${response.statusText}`)
            setValue('')
            reload()
          })
          .catch((cause) => setError(String((cause && cause.message) || cause)))
          .finally(() => setBusy(false))
      }

      const chip = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderRadius: 999,
        background: 'rgba(128,128,128,0.12)',
        fontSize: 12,
      }
      return h(
        'div',
        { 'data-channels-allowlist': '', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t('Allowed senders', '允许的发送者')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          list.length === 0
            ? h('span', { style: { fontSize: 12, opacity: 0.7 } }, t('Nobody yet — every message is refused.', '还没有人 —— 所有消息都会被拒绝。'))
            : list.map((sender) =>
                h('span', { key: sender, style: chip },
                  h('span', null, sender),
                  h('button', {
                    type: 'button',
                    'data-channels-remove': sender,
                    disabled: busy,
                    onClick: () => send({ remove: sender }),
                    title: t('Remove', '移除'),
                    style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', opacity: 0.7, padding: 0, fontSize: 12 },
                  }, '✕'),
                ),
              ),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            value,
            placeholder: t('sender id, e.g. wxid_xxx@im.wechat', '发送者 id，例如 wxid_xxx@im.wechat'),
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && value.trim() !== '' && !busy) send({ add: value.trim() })
            },
            style: {
              flex: 1,
              padding: '6px 10px',
              borderRadius: 'var(--dsw-radius-m, 10px)',
              border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
            },
          }),
          h('button', {
            type: 'button',
            disabled: busy || value.trim() === '',
            onClick: () => send({ add: value.trim() }),
            style: {
              padding: '6px 14px',
              borderRadius: 'var(--dsw-radius-m, 10px)',
              border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
              cursor: busy || value.trim() === '' ? 'default' : 'pointer',
              opacity: busy || value.trim() === '' ? 0.5 : 1,
            },
          }, busy ? t('Saving…', '保存中…') : t('Add', '添加')),
        ),
        error !== '' ? h('div', { 'data-channels-allowlist-error': '', style: { color: '#c92a2a', fontSize: 12 } }, error) : null,
      )
    }


    /**
     * The few settings that can change without a restart.
     *
     * Both the live value and the saved overlay change together, so the next
     * message obeys the new limit and a restart does not undo it. Fields that
     * need the adapter rebuilt are not here, on purpose: a form that lies about
     * taking effect immediately is worse than a small form.
     */
    function SettingsEditor({ data, reload, t }) {
      const live = data.settings || {}
      const [edits, setEdits] = React.useState({})
      const values = {
        senderPerMinute: String(live.senderPerMinute ?? 6),
        senderPerDay: String(live.senderPerDay ?? 60),
        autoSendFiles: live.autoSendFiles !== false,
        questionsEnabled: live.questionsEnabled !== false,
        approvalsEnabled: live.approvalsEnabled !== false,
        ...edits,
      }
      const [busy, setBusy] = React.useState(false)
      const [saved, setSaved] = React.useState('')
      const [error, setError] = React.useState('')

      const save = () => {
        setBusy(true)
        setError('')
        setSaved('')
        fetch('/channels/settings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(Object.fromEntries(Object.entries(edits).map(([key, value]) =>
            [key, key === 'senderPerMinute' || key === 'senderPerDay' ? Number(value) : value]))),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok !== true) throw new Error(body.detail || `${response.status} ${response.statusText}`)
            setEdits({})
            setSaved(t('Saved — it applies to the next message.', '已保存 —— 下一条消息就生效。'))
            reload()
          })
          .catch((cause) => setError(String((cause && cause.message) || cause)))
          .finally(() => setBusy(false))
      }

      const numberField = (label, key) =>
        h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } },
          h('span', { style: { opacity: 0.8 } }, label),
          h('input', {
            type: 'number',
            min: 0,
            value: values[key],
            disabled: busy,
            onChange: (event) => setEdits((current) => ({ ...current, [key]: event.target.value })),
            style: {
              width: 96,
              padding: '5px 8px',
              borderRadius: 'var(--dsw-radius-m, 10px)',
              border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
            },
          }),
        )

      const toggle = (label, key) =>
        h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
          h('input', {
            type: 'checkbox',
            checked: values[key],
            disabled: busy,
            onChange: (event) => setEdits((current) => ({ ...current, [key]: event.target.checked })),
          }),
          h('span', { style: { opacity: 0.85 } }, label),
        )

      return h(
        'div',
        { 'data-channels-settings': '', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, t('Limits and behaviour', '限流与行为')),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' } },
          numberField(t('Messages / minute (0 = unlimited)', '每分钟消息数（0 = 不限）'), 'senderPerMinute'),
          numberField(t('Messages / day (0 = unlimited)', '每天消息数（0 = 不限）'), 'senderPerDay'),
        ),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          toggle(t('Send files the agent produced', '发送 agent 产生的文件'), 'autoSendFiles'),
          toggle(t('Ask questions in the chat', '允许在聊天里提问'), 'questionsEnabled'),
          toggle(t('Approve tool calls in the chat', '允许在聊天里审批'), 'approvalsEnabled'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', {
            type: 'button',
            disabled: busy || Object.keys(edits).length === 0,
            onClick: save,
            style: {
              padding: '6px 14px',
              borderRadius: 'var(--dsw-radius-m, 10px)',
              border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
            },
          }, busy ? t('Saving…', '保存中…') : t('Save', '保存')),
          saved !== '' ? h('span', { style: { color: '#2f9e44', fontSize: 12 } }, saved) : null,
          error !== '' ? h('span', { 'data-channels-settings-error': '', style: { color: '#c92a2a', fontSize: 12 } }, error) : null,
        ),
      )
    }

    //#endregion

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
            console.warn('@derekluo/dsh-channels: chat row teardown failed', error)
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
        //
        // `apply` must return a disposer FUNCTION, not the injection handle:
        // returning the handle made the boot refuse the entry with
        // "TypeError: Invalid effect" and the row never appeared (found on the
        // device; the failure is one console line, easy to miss).
        let disposeRows
        let disposeCard
        const injection = ctx.inject(['uiConversation', 'slots'], (scope) => {
          try {
            disposeRows = registerRows(scope, scope.uiConversation)
          } catch (error) {
            console.warn('@derekluo/dsh-channels: chat row not registered', error)
            disposeRows = () => {}
          }
        })
        // The status card needs only `slots`, so it is registered
        // on its own: a host without the Conversation registry still gets it.
        const card = ctx.inject(['slots'], (scope) => {
          try {
            const disposer = scope.slots.inject('plugins.bundle.config', () =>
              scope.slots.register({ name: 'plugins.bundle.config', key: PKG }, createCard(translator())))
            // `slots.inject` returns the callback's own disposer on some hosts and
            // the registration result on others; only a function is worth keeping.
            disposeCard = typeof disposer === 'function' ? disposer : undefined
          } catch (error) {
            console.warn('@derekluo/dsh-channels: status card not registered', error)
          }
        })
        return () => {
          try {
            disposeRows?.()
          } catch (error) {
            console.warn('@derekluo/dsh-channels: chat row teardown failed', error)
          }
          try {
            if (typeof disposeCard === 'function') disposeCard()
          } finally {
            card?.dispose?.()
            injection?.dispose?.()
          }
        }
      },
    }
  },
})
