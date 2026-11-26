import type { CategoryOption } from './category-catalog'

export type RecoveryEvent = {
  event_id: string
  device_event_id: string
  source_package: string
  received_at: string
  status: 'received' | 'parse_failed'
  error_code: string | null
}

export type RecoveryCursor = { before_received_at: string; before_id: string }
export type RecoveryPage = { events: RecoveryEvent[]; next_cursor: RecoveryCursor | null }
export type RecoveryAccount = { id: string; name: string; kind: 'asset' | 'liability' }
export type RecoveryCategory = CategoryOption

export const recoveryPageSize = 25
