/**
 * Browser entry: registers the channel chat rows and the plugin status card
 * with the host's module loader. React is supplied by the host and stays
 * external to the bundle.
 */
import { PKG, CHANNELS, byKind, translator } from './channels.js'
import { definitionFor, createRow } from './rows.js'
import { createCard } from './card.js'

export function createClient(require) {
  const React = require('react')
  const h = React.createElement

  /** Register the Definition and its renderer; returns the disposer for both. */
  function registerRows(ctx, uiConversation) {
    const t = translator()
    const disposers = []
    for (const channel of CHANNELS) {
      if (!byKind.has(channel.id)) continue
      const disposeDefinition = uiConversation.events.register(definitionFor(channel))
      let disposeSeat
      const seat = ctx.slots.inject('conversation.chat.node', () => {
        disposeSeat = ctx.slots.register({ name: 'conversation.chat.node', key: channel.row }, createRow(channel, t, h))
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
      // whole client inactive.
      //
      // `apply` must return a disposer FUNCTION, not the injection handle:
      // returning the handle made the boot refuse the entry with
      // "TypeError: Invalid effect" and the row never appeared.
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
      // The status card needs only `slots`, so it is registered on its own: a
      // host without the Conversation registry still gets it.
      const card = ctx.inject(['slots'], (scope) => {
        try {
          const disposer = scope.slots.inject('plugins.bundle.config', () =>
            scope.slots.register({ name: 'plugins.bundle.config', key: PKG }, createCard(translator(), React, h)))
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
}

window.__ModuleLoader__.load({
  id: PKG,
  factory(require) {
    return createClient(require)
  },
})
