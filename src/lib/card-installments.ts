export type CardInstallmentPlan = {
  purchase_id: string
  merchant: string
  purchase_month: string
  available_minor: string
  reversed: boolean
  version: number
  first_month: string | null
  payment_count: number | null
  principal_minor: string | null
  fee_minor: string | null
  needs_review: boolean
}

export type CardInstallment = {
  purchase_id: string
  merchant: string
  account_name: string
  payment_number: number
  payment_count: number
  needs_review: boolean
  principal_minor: string | null
  fee_minor: string | null
}
