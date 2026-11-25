import type { RecoveryEvent } from './notification-recovery'

export type AccountKind = 'asset' | 'credit'
export type Account = { id: string; name: string; kind: AccountKind; opening: number; openedOn?: string }
export type Category = { id: string; name: string; budget: number }
type RecurringPayment = { id: string; name: string; due: string; amount: number; purchaseId?: string }
export type Purchase = {
  id: string
  merchant: string
  date: string
  amount: number
  accountId: string
  categoryId: string
  status: 'pending' | 'approved'
}
export type Finance = {
  accounts: Account[]
  categories: Category[]
  purchases: Purchase[]
  recoveryEvents?: RecoveryEvent[]
  recurring?: RecurringPayment[]
  ledgerStartsOn?: string
}

export const storageKey = 'asset-management:demo:v1'
const seoulDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
})
const sampleAccountIds = new Set(['bank', 'cash', 'card'])

export function today() {
  return seoulDate.format(new Date())
}

function atDate(date: string, monthsAgo: number, day: number) {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1 - monthsAgo, day)).toISOString().slice(0, 10)
}

export function demoRecurringPayments(date: string): RecurringPayment[] {
  const month = date.slice(0, 7)
  return [
    { id: 'demo-phone', name: '통신비', due: month + '-26', amount: 45000 },
    { id: 'demo-subscriptions', name: '정기 구독', due: month + '-27', amount: 32000 },
    { id: 'demo-utilities', name: '공과금', due: month + '-28', amount: 85000 },
    { id: 'demo-transport', name: '대중교통', due: date, amount: 2800, purchaseId: '3' },
  ]
}

export function demoFinance(): Finance {
  const date = today()
  const day = Number(date.slice(8))
  return {
    recurring: demoRecurringPayments(date),
    ledgerStartsOn: date.slice(0, 7) + '-01',
    accounts: [
      { id: 'bank', name: '생활비 통장', kind: 'asset', opening: 2480000 },
      { id: 'cash', name: '현금', kind: 'asset', opening: 150000 },
      { id: 'card', name: '생활비 신용카드', kind: 'credit', opening: 125000 },
    ],
    categories: [
      { id: 'food', name: '식비', budget: 350000 },
      { id: 'transport', name: '교통', budget: 120000 },
      { id: 'life', name: '생활', budget: 250000 },
    ],
    purchases: [
      { id: '1', merchant: '동네 마트', date: atDate(date, 0, Math.min(day, 5)), amount: 46500, accountId: 'bank', categoryId: 'life', status: 'approved' },
      { id: '2', merchant: '점심 식사', date: atDate(date, 0, Math.min(day, 9)), amount: 12800, accountId: 'card', categoryId: 'food', status: 'approved' },
      { id: '5', merchant: '월간 장보기', date: atDate(date, 0, Math.min(day, 14)), amount: 82900, accountId: 'bank', categoryId: 'food', status: 'approved' },
      { id: '6', merchant: '대중교통 정기권', date: atDate(date, 0, Math.min(day, 20)), amount: 68700, accountId: 'card', categoryId: 'transport', status: 'approved' },
      { id: '7', merchant: '생활용품', date, amount: 163000, accountId: 'card', categoryId: 'life', status: 'approved' },
      { id: '8', merchant: '동네 식당', date, amount: 18000, accountId: 'card', categoryId: 'food', status: 'pending' },
      { id: '9', merchant: '생활용품점', date, amount: 32000, accountId: 'card', categoryId: 'life', status: 'pending' },
      { id: '3', merchant: '대중교통', date, amount: 2800, accountId: 'card', categoryId: 'transport', status: 'pending' },
      { id: '4', merchant: '카페', date, amount: 5500, accountId: 'cash', categoryId: 'food', status: 'pending' },
    ],
  }
}

export function demoRecoveryEvents(): RecoveryEvent[] {
  const date = today()
  return [
    { event_id: 'demo-notice-1', device_event_id: 'demo-notice-1', source_package: 'com.example.card',
      received_at: date + 'T14:20:00+09:00', status: 'parse_failed', error_code: 'missing_fields' },
    { event_id: 'demo-notice-2', device_event_id: 'demo-notice-2', source_package: 'com.example.bank',
      received_at: date + 'T09:35:00+09:00', status: 'parse_failed', error_code: 'unrecognized_format' },
  ]
}

export function readDemoFinance(storage: Pick<Storage, 'getItem'>): Finance {
  const saved = storage.getItem(storageKey)
  if (!saved) return demoFinance()
  const date = today()
  const { openingHistory, ...original } = JSON.parse(saved) as Finance & { openingHistory?: { date: string }[] }
  const lastLegacyMonth = openingHistory?.at(-1)?.date
  const defaultPayments = demoRecurringPayments(date)
  const recurring = original.recurring?.filter((item) => item.due.startsWith(date.slice(0, 7)))
  return {
    ...original,
    accounts: original.accounts.map((account) => account.openedOn || sampleAccountIds.has(account.id)
      ? account : { ...account, openedOn: date }),
    ledgerStartsOn: original.ledgerStartsOn ?? (lastLegacyMonth ? atDate(lastLegacyMonth, -1, 1) : date.slice(0, 7) + '-01'),
    recurring: recurring?.length ? recurring.map((item) => ({
      ...item, name: item.name ?? defaultPayments.find((entry) => entry.id === item.id)?.name ?? '정기 결제',
    })) : defaultPayments,
  }
}

export function accountBalance(account: Account, approved: Purchase[]) {
  const purchases = approved
    .filter((purchase) => purchase.accountId === account.id)
    .reduce((total, purchase) => total + purchase.amount, 0)
  return account.opening + (account.kind === 'credit' ? purchases : -purchases)
}

export function amount(value: FormDataEntryValue | null, minimum = 0) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= 100_000_000_000 ? parsed : null
}
