import type { SupabaseClient } from '@supabase/supabase-js'

type ExportedTransaction = [id: string, kind: string, description: string, amount: string, currency: string,
  date: string, pendingId: string | null, originalId: string | null]
type Allocation = { transaction_id: string; category_id: string; amount_minor: string }
type Lookup = { transaction_id: string }

export async function readPages<Row>(load: (start: number, end: number) => PromiseLike<{ data: Row[] | null; error: unknown }>) {
  const found: Row[] = []
  const pageSize = 250
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await load(start, start + pageSize - 1)
    if (error || !data) return null
    found.push(...data)
    if (data.length < pageSize) return found
  }
}

async function readByIds<Row>(ids: string[], load: (batch: string[]) => PromiseLike<{ data: Row[] | null; error: unknown }>) {
  const rows: Row[] = []
  const unique = Array.from(new Set(ids))
  for (let start = 0; start < unique.length; start += 100) {
    const { data, error } = await load(unique.slice(start, start + 100))
    if (error || !data) return null
    rows.push(...data)
  }
  return rows
}

export async function loadLedgerCategory(supabase: SupabaseClient, userId: string, month: string, category: string) {
  const exported = await supabase.rpc('get_monthly_ledger_export', { p_month: month + '-01', p_kind: 'transactions' })
  if (exported.error || !Array.isArray(exported.data)) return null
  const rows = (exported.data as ExportedTransaction[]).filter((row) => row[4] === 'KRW')
  const purchases = rows.filter((row) => ['purchase_cash', 'purchase_credit', 'purchase_debit'].includes(row[1])).map((row) => row[0])
  const refunds = rows.filter((row) => row[1] === 'purchase_refund')
  const fees = rows.filter((row) => row[1] === 'transfer_fee').map((row) => row[0])
  const reporting = await supabase.from('reporting_purchase_categories').select('transaction_id').limit(0)
  const splitTable = reporting.error ? 'transaction_splits' : 'reporting_purchase_categories'
  const refundTable = reporting.error ? 'refund_allocations' : 'reporting_refund_categories'
  const feeTable = reporting.error ? 'transfer_fees' : 'reporting_fee_categories'
  const [splits, reversed, refundAllocations, categoryFees] = await Promise.all([
    readByIds<Allocation>([...purchases, ...refunds.flatMap((row) => row[7] ? [row[7]] : [])], (ids) =>
      supabase.from(splitTable).select('transaction_id,category_id,amount_minor::text')
        .eq('user_id', userId).eq('category_id', category).in('transaction_id', ids).returns<Allocation[]>()),
    readByIds<{ original_purchase_id: string }>(purchases, (ids) =>
      supabase.from('purchase_reversals').select('original_purchase_id').eq('user_id', userId).in('original_purchase_id', ids)),
    readByIds<Allocation>(refunds.map((row) => row[0]), async (ids) => {
      const data = await readPages<Allocation>((start, end) => supabase.from(refundTable).select('transaction_id,category_id,amount_minor::text')
        .eq('user_id', userId).in('transaction_id', ids).order('transaction_id').order('category_id').range(start, end).returns<Allocation[]>())
      return { data, error: null }
    }),
    readByIds<Lookup>(fees, (ids) => supabase.from(feeTable).select('transaction_id')
      .eq('user_id', userId).eq('category_id', category).in('transaction_id', ids)),
  ])
  if (!splits || !reversed || !refundAllocations || !categoryFees) return null
  const splitAmounts = new Map(splits.map((row) => [row.transaction_id, row.amount_minor]))
  const excluded = new Set(reversed.map((row) => row.original_purchase_id))
  const allocatedRefunds = new Set(refundAllocations.map((row) => row.transaction_id))
  const refundAmounts = new Map(refundAllocations.filter((row) => row.category_id === category).map((row) => [row.transaction_id, row.amount_minor]))
  const feeIds = new Set(categoryFees.map((row) => row.transaction_id))
  const purchaseIds = new Set(purchases)
  return rows.flatMap(([id, kind, description, amount, , date, , originalId]) => {
    let allocated: string | undefined
    if (kind === 'purchase_refund') {
      const legacyRefund = !allocatedRefunds.has(id) && originalId && splitAmounts.has(originalId)
      allocated = refundAmounts.get(id) ?? (legacyRefund ? amount : undefined)
      if (allocated !== undefined) allocated = '-' + allocated
    } else if (feeIds.has(id)) {
      allocated = amount
    } else if (purchaseIds.has(id) && !excluded.has(id)) {
      allocated = splitAmounts.get(id)
    }
    return allocated === undefined ? [] : [{ id, kind, description, date, amount: allocated }]
  }).reverse()
}
