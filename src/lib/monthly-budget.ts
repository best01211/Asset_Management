export function isBudgetMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && value >= '1900-01' && value <= '9998-12'
}

export type BudgetLimit = { amount_minor: string | null; version: number | null }
export type MonthlyBudget = {
  month: string
  spent_minor: string
  total: BudgetLimit | null
  categories: (BudgetLimit & { category_id: string; name: string; spent_minor: string })[]
}
