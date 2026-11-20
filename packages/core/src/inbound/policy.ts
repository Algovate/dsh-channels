/**
 * Inbound admission policy that does not touch storage or the host.
 *
 * Two questions are pure functions of the message and config: is this group
 * message addressed to the bot, and may it skip the media queue because it is
 * a control or an answer the running turn is waiting for? Keeping them here
 * makes the rules directly testable and keeps the runtime focused on ordering,
 * gates and turns.
 *
 * @module @derekluo/dsh-channels/inbound/policy
 */
import { isApprovalReply } from '../interaction/approval.js'
import { parseCommand, TASK_CONTROLS } from '../commands.js'
import type { ChannelsConfig } from '../config.js'
import type { InboundMessage } from '../types.js'

export interface AddressedText {
  addressed: boolean
  /** The message text with the group prefix or bot mention stripped. */
  text: string
}

export type GroupConfig = Pick<ChannelsConfig, 'groupTrigger' | 'groupPrefix' | 'groupMention'>

/**
 * Group addressing: `all` keeps the old behavior; `prefix` requires the
 * configured prefix; `mention` accepts the prefix or the configured bot handle.
 * Either is stripped before command parsing or the turn. An active interaction
 * may be answered without addressing the bot.
 */
export function groupText(message: InboundMessage, config: GroupConfig, interactionBusy: boolean): AddressedText {
  if (!message.group || config.groupTrigger === 'all') return { addressed: true, text: message.text }
  const raw = message.text.trimStart()
  const prefix = config.groupPrefix
  if (raw === prefix || raw.startsWith(`${prefix} `) || raw.startsWith(`${prefix}\n`) || raw.startsWith(`${prefix}\t`)) {
    return { addressed: true, text: raw.slice(prefix.length).trimStart() }
  }
  if (config.groupTrigger === 'mention' && config.groupMention !== '') {
    const mention = config.groupMention
    if (raw.toLowerCase().startsWith(mention.toLowerCase())) {
      const rest = raw.slice(mention.length)
      if (rest === '' || /^[\s,，:：]/.test(rest)) return { addressed: true, text: rest.trimStart() }
    }
  }
  return { addressed: interactionBusy, text: message.text }
}

/**
 * Classification only: control commands, approval replies and answers to a
 * waiting interaction may bypass media work. Adapters still call `canReceive`
 * before handing such a message off; this never authorizes delivery.
 */
export function canBypassPolicy(message: InboundMessage, config: GroupConfig, interactionBusy: boolean): boolean {
  const group = groupText(message, config, interactionBusy)
  if (!group.addressed) return false
  const command = parseCommand(group.text)
  return (command !== null && TASK_CONTROLS.has(command.name)) || isApprovalReply(group.text) || interactionBusy
}
