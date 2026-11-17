/** Shared data contract for the authenticated HTTP status route. */
export interface ChannelStatusView {
  id: string
  label: { en: string; zh: string }
  accounts: Array<{ accountId: string; label?: string; expired: boolean; allowedSenders: number }>
  maxTextChars: number
  media: { image: boolean; file: boolean; voice: boolean; video: boolean }
}

export interface StatusPayload {
  stateRoot: string
  channels: ChannelStatusView[]
  allowlist: string[]
  inboxPending: number
  outboxPending: number
  journal: Array<{ at: number; kind: string; state: string; text: string }>
  interactions: { pending: boolean }
  settings: {
    senderPerMinute: number
    senderPerDay: number
    autoSendFiles: boolean
    questionsEnabled: boolean
    approvalsEnabled: boolean
  }
}
