export const reviewStatuses = ['pending_review', 'duplicate_suspected', 'confirmed', 'dismissed'] as const
export const duplicateActions = ['flag', 'keep', 'dismiss'] as const
export type DuplicateAction = typeof duplicateActions[number]
export const paymentMethods = ['credit_card', 'debit_card', 'cash'] as const
export const approvalBatchLimit = 20
export type ReviewStatus = typeof reviewStatuses[number]
export type PaymentMethod = typeof paymentMethods[number]

export type ReviewTransaction = {
  id: string
  merchant: string
  amount_minor: string
  currency: string
  occurred_at: string
  payment_method: PaymentMethod
  payment_account_id: string
  category_id: string
  status: ReviewStatus
  version: number
  confirmed_transaction_id: string | null
  account: { name: string } | null
  category: { name: string } | null
  allocations?: { category_id: string }[]
}

export type ReviewCursor = { before_occurred_at: string; before_id: string }
export type ReviewPage = { transactions: ReviewTransaction[]; next_cursor: ReviewCursor | null }

export const paymentLabels: Record<PaymentMethod, string> = {
  credit_card: '신용카드',
  debit_card: '체크카드',
  cash: '현금',
}
