export const activityTypes = ['balance_check', 'card_payment', 'own_transfer', 'purchase_refund'] as const
export type ActivityType = typeof activityTypes[number]

export type ActivityAccount = {
  id: string
  name: string
  kind: 'asset' | 'liability'
  active: boolean
  opening_effective_at: string | null
}
export type BalanceCheck = {
  id: string
  account_name: string
  observed_at: string
  actual_minor: string
  ledger_minor: string
  difference_minor: string
  adjustment_transaction_id: string | null
}
export type RefundPurchase = {
  id: string
  merchant: string
  amount_minor: string
  occurred_at: string
  remaining_minor: string
  reversal_id: string | null
  reversal_reason: string | null
  has_refunds: boolean
  allocations: { category_id: string; name: string; amount_minor: string }[]
}
export type AccountActivity = {
  accounts: ActivityAccount[]
  checks: BalanceCheck[]
  purchase: RefundPurchase | null
  categories: { id: string; name: string }[]
}
