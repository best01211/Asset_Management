import { monthEnd } from './home-dates'
import { today } from './local-finance'
import { formatWon } from './format-finance'
import type { CategoryAssignment } from './category-catalog'

export type Option = { id: string; name: string }
export type Annotation = { memo: string; tags: string[]; version: number }
export type HistoryRow = {
  id: string; name: string; date: string; amount: string; currency: string; kind: string
  categories: Option[]; accounts: Option[]; payment?: string; source: string; pendingId?: string
  annotation?: Annotation; reversed?: boolean; categoryAssignments?: CategoryAssignment[]
}
export type HistorySummary = { income: string; expense: string; net: string; count: number; month: string }
export type HistoryData = { rows: HistoryRow[]; summary: HistorySummary | null; annotations: boolean }
export type HistoryDetails = {
  related: { id: string; name: string; date: string; kind: string }[]
  audit: { id: string; date: string; action: string }[]
}

export const kindLabels: Record<string, string> = {
  purchase_credit: '지출', purchase_debit: '지출', purchase_cash: '지출',
  transfer_fee: '수수료', own_transfer: '이체', card_payment: '카드 대금 납부',
  purchase_refund: '환불', purchase_reversal: '정정', balance_adjustment: '잔액 조정', income: '수입',
}
export const isPurchase = (kind: string) => ['purchase_credit', 'purchase_debit', 'purchase_cash'].includes(kind)
export function transactionType(kind: string) {
  if (isPurchase(kind) || kind === 'transfer_fee') return 'expense'
  if (kind === 'income') return 'income'
  if (kind === 'own_transfer' || kind === 'card_payment') return 'transfer'
  return 'other'
}

export function defaultRange() {
  const date = today()
  return { from: date.slice(0, 7) + '-01', to: monthEnd(date) }
}

export function validRange(from: string, to: string) {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01'
    && value <= '9998-12-31' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value)
  return valid(from) && valid(to) && from <= to && Date.parse(to) - Date.parse(from) <= 365 * 86_400_000
}

function currencyFormat(currency: string) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency, currencyDisplay: 'code' })
}

export function formatMinor(amount: string, currency: string) {
  if (currency === 'KRW') return formatWon(amount)
  const value = BigInt(amount)
  const formatter = currencyFormat(currency)
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0
  const factor = 10n ** BigInt(digits)
  const absolute = value < 0n ? -value : value
  return (value < 0n ? '−' : '') + formatter.formatToParts(absolute / factor).map((part) =>
    part.type === 'fraction' ? (absolute % factor).toString().padStart(digits, '0') : part.value).join('')
}

export function amountWithin(amount: string, currency: string, minimum: string, maximum: string) {
  const digits = currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 0
  const compare = (bound: string) => {
    const [whole, fraction = ''] = bound.split('.')
    const scale = Math.max(digits, fraction.length)
    return BigInt(amount) * 10n ** BigInt(scale - digits) - BigInt(whole + fraction.padEnd(scale, '0'))
  }
  return (!minimum || compare(minimum) >= 0n) && (!maximum || compare(maximum) <= 0n)
}
