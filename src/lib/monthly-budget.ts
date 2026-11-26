import { monthEnd, monthsBefore } from './home-dates'

export function isBudgetMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && value >= '1900-01' && value <= '9998-12'
}

export function isBudgetAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n
}

export type BudgetLimit = { amount_minor: string | null; version: number | null }
export type MonthlyBudget = {
  month: string
  spent_minor: string
  total: BudgetLimit | null
  categories: (BudgetLimit & { category_id: string; name: string; spent_minor: string })[]
}

export type BudgetWorkspaceData = MonthlyBudget & {
  today: string
  previous: MonthlyBudget | null
  pending: { count: number; won_minor: string; duplicate_count: number; foreign_count: number }
  scheduled: { id: string; service_id: string; due_on: string; name: string; category_id: string | null; account_name: string | null; currency: string; remaining_minor: string }[]
  daily: { day: string; category_id: string | null; amount_minor: string; variable_minor: string; variable_day: boolean }[]
}

export const warningPercent = 80n
type BudgetStatus = 'over' | 'warning' | 'normal' | 'unknown' | 'unset'
export const budgetWon = (amount: bigint) => amount.toLocaleString('ko-KR') + '원'
export const sumAmounts = (values: bigint[]) => values.reduce((total, value) => total + value, 0n)
export const budgetPercent = (tenths: bigint) => `${tenths < 0n ? '-' : ''}${(tenths < 0n ? -tenths : tenths) / 10n}.${(tenths < 0n ? -tenths : tenths) % 10n}%`
export const differenceRate = (current: bigint, previous: bigint) => previous > 0n ? (current - previous) * 1000n / previous : null

export function analyzeBudget(data: BudgetWorkspaceData) {
  const { month, today, daily, scheduled } = data
  const end = monthEnd(month + '-01')
  const days = Number(end.slice(8))
  const active = today.startsWith(month)
  const closed = end < today
  const cutoff = active ? today : closed ? end : null
  const previousMonth = data.previous?.month
  const previousEnd = previousMonth && (active ? monthsBefore(today, 1) : monthEnd(previousMonth + '-01'))
  const previousDaily = daily.filter((row) => row.day.startsWith(previousMonth ?? '_'))
  const comparable = Boolean(cutoff && previousEnd && previousDaily.some((row) => row.category_id === null && row.day <= previousEnd))
  const currentDaily = daily.filter((row) => row.day.startsWith(month) && cutoff && row.day <= cutoff)
  const last = (id: string | null) => comparable
    ? sumAmounts(previousDaily.filter((row) => row.day <= previousEnd! && row.category_id === id).map((row) => BigInt(row.amount_minor))) : null

  const target = data.total?.amount_minor == null ? null : BigInt(data.total.amount_minor)
  const spent = BigInt(data.spent_minor)
  const pendingWon = sumAmounts(scheduled.filter((row) => row.currency === 'KRW').map((row) => BigInt(row.remaining_minor)))
  const foreign = scheduled.some((row) => row.currency !== 'KRW')
  const remaining = target === null || foreign ? null : target - spent - pendingWon
  const remainingDays = active ? days - Number(today.slice(8)) : 0
  const previousDays = previousMonth ? Number(monthEnd(previousMonth + '-01').slice(8)) : 0

  function forecast(actual: bigint, expected: bigint, currencyMissing: boolean, id?: string) {
    if (!active || currencyMissing) return null
    if (remainingDays === 0) return actual + expected
    const history = previousDaily.filter((row) => row.category_id !== null && (id === undefined || id === row.category_id))
    const observed = new Set(history.filter((row) => row.variable_day).map((row) => row.day)).size
    if (observed < (id === undefined ? 7 : 3) || previousDays <= 0) return null
    const variable = sumAmounts(history.map((row) => BigInt(row.variable_minor)))
    if (variable < 0n) return null
    return actual + expected + (variable * BigInt(remainingDays) + BigInt(Math.floor(previousDays / 2))) / BigInt(previousDays)
  }

  const categories = data.categories.map((item) => {
    const id = item.category_id
    const actual = BigInt(item.spent_minor)
    const limit = item.amount_minor === null ? null : BigInt(item.amount_minor)
    const pending = scheduled.filter((row) => row.category_id === id)
    const expected = sumAmounts(pending.filter((row) => row.currency === 'KRW').map((row) => BigInt(row.remaining_minor)))
    const projected = forecast(actual, expected, pending.some((row) => row.currency !== 'KRW'), id)
    const usage = limit && limit > 0n ? actual * 1000n / limit : null
    const status: BudgetStatus = limit === null ? 'unset' : actual > limit ? 'over'
      : (limit > 0n && actual * 100n >= limit * warningPercent) || (projected !== null && projected > limit) ? 'warning'
      : projected === null && !closed ? 'unknown' : 'normal'
    const comparing = sumAmounts(currentDaily.filter((row) => row.category_id === id).map((row) => BigInt(row.amount_minor)))
    return { ...item, actual, comparing, limit, usage, projected, status, previous: last(id), balance: limit === null ? null : limit - actual }
  }).sort((a, b) => {
    const priority = (item: typeof a) => item.status === 'over' ? 0 : item.status === 'warning' ? 1 : item.limit !== null ? 2 : item.actual !== 0n ? 3 : 4
    return priority(a) - priority(b) || (a.actual > b.actual ? -1 : a.actual < b.actual ? 1 : a.name.localeCompare(b.name, 'ko'))
  })

  const totalByDay = new Map(currentDaily.filter((row) => row.category_id === null)
    .map((row) => [row.day, BigInt(row.amount_minor)]))
  let cumulative = 0n
  const chart = totalByDay.size ? Array.from({ length: days }, (_, index) => {
    const day = `${month}-${String(index + 1).padStart(2, '0')}`
    cumulative += totalByDay.get(day) ?? 0n
    return { day, amount: cutoff && day <= cutoff ? cumulative : null, target: target === null ? null : target * BigInt(index + 1) / BigInt(days) }
  }) : []

  const previous = cutoff ? last(null) : null
  const comparisonTotal = sumAmounts([...totalByDay.values()])
  return { target, spent, pendingWon, foreign, remaining, projected: forecast(spent, pendingWon, foreign),
    categories, active, closed, cutoff, previousEnd, previous, comparisonTotal, chart, previousDays }
}

export type BudgetAnalysis = ReturnType<typeof analyzeBudget>
export type BudgetCategory = BudgetAnalysis['categories'][number]
