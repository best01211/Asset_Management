import { daysBetween } from './home-dates'

export const serviceStatuses = { active: '활성', paused: '일시중지', cancelled: '해지' } as const
export const paymentStatuses = { scheduled: '예정', completed: '완료', needs_review: '확인 필요', skipped: '제외' } as const
export const issueLabels = { ambiguous: '여러 회차와 일치', different_amount: '예상 금액과 다름', account_missing: '결제 계좌 미등록' } as const
export const alertLabels = { advance: '결제 예정', overdue: '결제 확인 필요', conflict: '자동 연결 확인 필요' } as const
export type ServiceStatus = keyof typeof serviceStatuses
export type PaymentStatus = keyof typeof paymentStatuses
export type ServiceInput = {
  name: string; amount_minor: string; currency: string; cycle_unit: 'day' | 'month'; cycle_count: number;
  anchor_on: string; end_on: string | null; effective_on: string | null;
  category_id: string | null; account_id: string | null; status: ServiceStatus; auto_match: boolean;
  aliases: string[]; web_enabled: boolean; push_enabled: boolean; advance_days: number; unmatched_alert: boolean; note: string;
}
export type RecurringService = ServiceInput & {
  id: string; version: number; current_status: ServiceStatus; next_due: string | null; effective_on: string;
  category_name: string | null; account_name: string | null; month_status: PaymentStatus | null
}
export type RecurringCandidate = {
  id: string; name: string; amount_minor: string; currency: string; occurred_at: string; account_name: string
}
export type RecurringLink = Omit<RecurringCandidate, 'account_name' | 'currency'> & {
  method: 'automatic' | 'manual'; reason: string; matched_at: string; reversed?: boolean
}
export type Occurrence = {
  id: string; service_id: string; name: string; due_on: string; currency: string; category_id: string | null; account_id: string | null;
  amount_minor: string; actual_minor: string; remaining_minor: string; status: PaymentStatus;
  match_issue: keyof typeof issueLabels | null; skipped: boolean; links: RecurringLink[]
}
export type RecurringAlert = {
  id: string; occurrence_id: string; service_id: string; kind: keyof typeof alertLabels; due_on: string;
  name: string; read_at: string | null
}
export type RecurringMonth = { month: string; today: string; services: RecurringService[]; occurrences: Occurrence[]; alerts: RecurringAlert[] }
export type ServiceHistory = {
  revisions: { version: number; effective_on: string; status: ServiceStatus; amount_minor: string; currency: string; name: string }[]
  payments: { id: string; due_on: string; actual_minor: string; currency: string; status: PaymentStatus; links: RecurringLink[] }[]
}

export function monthTotals(occurrences: Occurrence[]) {
  const totals = new Map<string, { expected: bigint; actual: bigint; remaining: bigint }>()
  for (const item of occurrences) {
    const expected = item.status === 'skipped' ? 0n : BigInt(item.amount_minor)
    const actual = BigInt(item.actual_minor)
    const remaining = BigInt(item.remaining_minor)
    if (expected === 0n && actual === 0n && remaining === 0n) continue
    const current = totals.get(item.currency) ?? { expected: 0n, actual: 0n, remaining: 0n }
    totals.set(item.currency, {
      expected: current.expected + expected,
      actual: current.actual + actual,
      remaining: current.remaining + remaining,
    })
  }
  return totals
}

export function recurringDueLabel(date: string, due: string) {
  const days = daysBetween(date, due)
  return days === 0 ? 'D-Day' : days > 0 ? 'D-' + days : 'D+' + -days
}
export function cycleLabel(unit: ServiceInput['cycle_unit'], count: number) {
  if (unit === 'month') return count === 1 ? '매월' : count === 12 ? '매년' : count + '개월마다'
  return count === 7 ? '매주' : count === 1 ? '매일' : count + '일마다'
}
export function changeMonth(month: string, offset: number) {
  const [year, index] = month.split('-').map(Number)
  const date = new Date(month + '-01T00:00:00Z')
  date.setUTCFullYear(year, index - 1 + offset, 1)
  return date.toISOString().slice(0, 7)
}

function fractionDigits(currency: string) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 0
}
export function parseRecurringAmount(raw: string, currency: string) {
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{1,19}(\.\d{1,6})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  const digits = fractionDigits(currency)
  if (fraction.length > digits) return null
  const minor = BigInt(whole + fraction.padEnd(digits, '0'))
  return minor > 0n && minor <= 9223372036854775807n ? minor.toString() : null
}
export function recurringAmountInput(minor: string, currency: string) {
  const digits = fractionDigits(currency)
  if (!digits) return minor
  const padded = minor.padStart(digits + 1, '0')
  return padded.slice(0, -digits) + '.' + padded.slice(-digits)
}
