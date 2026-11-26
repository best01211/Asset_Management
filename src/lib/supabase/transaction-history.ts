import type { SupabaseClient } from '@supabase/supabase-js'
import { defaultRange } from '../transaction-history'
import type { Annotation, HistoryData, HistoryDetails, HistoryRow, Option } from '../transaction-history'
import { paymentLabels } from '../transaction-review'
import type { PaymentMethod } from '../transaction-review'
import { readPages } from './ledger-category'

type NamedAccount = Option & { kind: string }
type LedgerRow = {
  id: string; merchant: string; occurred_at: string; amount_minor: string; currency: string; kind: string
  source_pending_id: string | null
  pending: { payment_method: PaymentMethod; notification_event_id: string | null } | null
  entries: { amount_minor: string; side: string; account: NamedAccount }[]
  splits: { category: Option }[]
  refunds: { category: Option }[]
  movement: { fee: { category: Option } | null; original: { id: string; splits: { category: Option }[] } | null } | null
  reversal: { reason: string } | null
}
type Related = { id: string; merchant: string; occurred_at: string; kind: string }
type AnnotationRow = Annotation & { transaction_id: string }
type OverrideRow = { transaction_id: string; source_category_id: string; target: Option }

const ledgerFields = [
  'id,merchant,occurred_at,amount_minor::text,currency,kind,source_pending_id',
  'pending:pending_transactions!transactions_user_id_source_pending_id_fkey(payment_method,notification_event_id)',
  'entries:ledger_entries!ledger_entries_user_id_transaction_id_fkey(amount_minor::text,side,account:financial_accounts!ledger_entries_user_id_account_id_fkey(id,name,kind))',
  'splits:transaction_splits!transaction_splits_user_id_transaction_id_fkey(category:categories!transaction_splits_user_id_category_id_fkey(id,name))',
  'refunds:refund_allocations!refund_allocations_user_id_transaction_id_fkey(category:categories!refund_allocations_user_id_category_id_fkey(id,name))',
  'movement:account_movements!account_movements_user_id_transaction_id_fkey(fee:transfer_fees!transfer_fees_user_id_transaction_id_fkey(category:categories!transfer_fees_user_id_category_id_fkey(id,name)),original:transactions!account_movements_user_id_original_purchase_id_fkey(id,splits:transaction_splits!transaction_splits_user_id_transaction_id_fkey(category:categories!transaction_splits_user_id_category_id_fkey(id,name))))',
  'reversal:purchase_reversals!purchase_reversals_user_id_original_purchase_id_fkey(reason)',
].join(',')

function nextDate(day: string) {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)
}

function readLedger(supabase: SupabaseClient, userId: string, from: string, to: string) {
  return readPages<LedgerRow>((start, end) => supabase.from('transactions').select(ledgerFields)
    .eq('user_id', userId).neq('kind', 'opening_balance')
    .gte('occurred_at', from + 'T00:00:00+09:00').lt('occurred_at', nextDate(to) + 'T00:00:00+09:00')
    .order('occurred_at', { ascending: false }).order('id', { ascending: false }).range(start, end)
    .overrideTypes<LedgerRow[], { merge: false }>())
}

function income(row: LedgerRow) {
  return row.entries.reduce((total, entry) => entry.account.kind !== 'income' ? total :
    total + BigInt(entry.amount_minor) * (entry.side === 'credit' ? 1n : -1n), 0n)
}

function uniqueOptions(entries: Option[]) {
  return [...new Map(entries.map((item) => [item.id, { id: item.id, name: item.name }] as const)).values()]
}

async function readAnnotations(supabase: SupabaseClient, userId: string, rows: LedgerRow[]) {
  const map = new Map<string, Annotation>()
  // The empty query also checks whether annotations are installed before displaying controls.
  for (let start = 0; start < Math.max(rows.length, 1); start += 100) {
    const query = supabase.from('transaction_annotations').select('transaction_id,memo,tags,version').eq('user_id', userId)
    const ids = rows.slice(start, start + 100).map((row) => row.id)
    const { data, error } = await (ids.length ? query.in('transaction_id', ids) : query.limit(0)).returns<AnnotationRow[]>()
    if (error || !data) return null
    for (const row of data) map.set(row.transaction_id, { memo: row.memo, tags: row.tags, version: row.version })
  }
  return map
}

async function readCategoryOverrides(supabase: SupabaseClient, userId: string, rows: LedgerRow[]) {
  const ids = [...new Set(rows.flatMap((row) => row.movement?.original ? [row.id, row.movement.original.id] : [row.id]))]
  const result = new Map<string, Option>()
  for (let start = 0; start < ids.length; start += 100) {
    const entries = await readPages<OverrideRow>((offset, end) => supabase.from('transaction_category_overrides')
      .select('transaction_id,source_category_id,target:categories!transaction_category_overrides_user_id_category_id_fkey(id,name)')
      .eq('user_id', userId).in('transaction_id', ids.slice(start, start + 100))
      .order('transaction_id').order('source_category_id').range(offset, end).overrideTypes<OverrideRow[], { merge: false }>())
    if (!entries) return null
    for (const entry of entries) result.set(entry.transaction_id + '/' + entry.source_category_id, entry.target)
  }
  return result
}

export async function loadHistory(supabase: SupabaseClient, userId: string, from: string, to: string): Promise<HistoryData | null> {
  const current = defaultRange()
  const month = current.from.slice(0, 7)
  const rowsRequest = readLedger(supabase, userId, from, to)
  const monthRequest = from === current.from && to === current.to ? rowsRequest : readLedger(supabase, userId, current.from, current.to)
  const [rows, monthRows, spending] = await Promise.all([
    rowsRequest, monthRequest, supabase.rpc('summarize_confirmed_purchases', { p_month: current.from }),
  ])
  if (!rows) return null
  const [metadata, overrides] = await Promise.all([readAnnotations(supabase, userId, rows), readCategoryOverrides(supabase, userId, rows)])
  const transactions = rows.map((row): HistoryRow => {
    const resolved = (transaction: string, category: Option) => overrides?.get(transaction + '/' + category.id) ?? category
    const direct = [...row.splits, ...(row.movement?.fee ? [row.movement.fee] : [])].map(({ category }) => category)
    const eligible = ['purchase_cash', 'purchase_debit', 'purchase_credit', 'transfer_fee'].includes(row.kind) && !row.reversal
    const refund = row.refunds.length ? row.refunds : row.movement?.original?.splits ?? []
    return {
      id: row.id, name: row.merchant, date: row.occurred_at, amount: row.amount_minor, currency: row.currency,
      kind: income(row) > 0n ? 'income' : row.kind, payment: row.pending ? paymentLabels[row.pending.payment_method] : undefined,
      accounts: uniqueOptions(row.entries.filter(({ account }) => account.kind === 'asset' || account.kind === 'liability').map(({ account }) => account)),
      categories: uniqueOptions([...direct.map((category) => resolved(row.id, category)),
        ...refund.map(({ category }) => resolved(row.movement?.original?.id ?? row.id, category))]),
      categoryAssignments: eligible && overrides ? direct.map((category) => {
        const current = resolved(row.id, category)
        return { sourceId: category.id, currentId: current.id, name: current.name }
      }) : undefined,
      source: row.pending?.notification_event_id ? '결제 알림' : row.source_pending_id ? '사용자 입력 · 가져오기' : '원장 작업',
      pendingId: row.source_pending_id ?? undefined, annotation: metadata?.get(row.id),
      reversed: Boolean(row.reversal),
    }
  })
  const totals = spending.data as { gross_spending_minor: string; fee_minor: string; spending_minor: string } | null
  const summary = monthRows && !spending.error && totals ? {
    month, count: monthRows.length, net: totals.spending_minor,
    income: monthRows.filter((row) => row.currency === 'KRW').reduce((sum, row) => sum + income(row), 0n).toString(),
    expense: (BigInt(totals.gross_spending_minor) + BigInt(totals.fee_minor)).toString(),
  } : null
  return { rows: transactions, summary, annotations: metadata !== null }
}

export async function loadHistoryDetails(supabase: SupabaseClient, userId: string, id: string): Promise<HistoryDetails | null> {
  const { data: row, error } = await supabase.from('transactions').select('source_pending_id').eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) throw new Error('TRANSACTION_LOOKUP_FAILED')
  if (!row) return null
  const [movements, reversals, audit] = await Promise.all([
    readPages<{ transaction_id: string; original_purchase_id: string | null }>((start, end) => supabase.from('account_movements')
      .select('transaction_id,original_purchase_id').eq('user_id', userId)
      .or('transaction_id.eq.' + id + ',original_purchase_id.eq.' + id).order('transaction_id').range(start, end)),
    supabase.from('purchase_reversals').select('transaction_id,original_purchase_id').eq('user_id', userId)
      .or('transaction_id.eq.' + id + ',original_purchase_id.eq.' + id),
    supabase.from('audit_logs').select('id,action,created_at').eq('user_id', userId)
      .in('entity_id', row.source_pending_id ? [id, row.source_pending_id] : [id])
      .order('created_at', { ascending: false }).order('id').limit(100),
  ])
  if (!movements || reversals.error || audit.error) throw new Error('TRANSACTION_DETAILS_FAILED')
  const ids = [...new Set([...movements, ...reversals.data].flatMap((entry) => [entry.transaction_id, entry.original_purchase_id]))]
    .filter((value): value is string => Boolean(value) && value !== id)
  const related: Related[] = []
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await supabase.from('transactions').select('id,merchant,occurred_at,kind')
      .eq('user_id', userId).in('id', ids.slice(start, start + 100)).returns<Related[]>()
    if (error) throw new Error('RELATED_TRANSACTIONS_FAILED')
    related.push(...data)
  }
  return {
    related: related.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).map((item) => ({
      id: item.id, name: item.merchant, date: item.occurred_at, kind: item.kind,
    })),
    audit: audit.data.map((item) => ({ id: item.id, date: item.created_at, action: item.action })),
  }
}
