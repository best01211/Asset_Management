import type { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { purchaseOptions } from '@/lib/supabase/purchase-options'
import { readPages } from '@/lib/supabase/ledger-category'
import { today } from '@/lib/local-finance'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const service = params.get('service')
  const occurrence = params.get('occurrence')
  const transaction = params.get('transaction')
  const month = params.get('month') ?? today().slice(0, 7)
  if ((service !== null && !isUuid(service)) || (occurrence !== null && !isUuid(occurrence))
    || (transaction !== null && !isUuid(transaction)) || !isBudgetMonth(month) || month > '9997-12')
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  if (params.get('options') === '1') {
    const [purchase, accounts] = await Promise.all([
      purchaseOptions(supabase, user.id),
      readPages<{ id: string; name: string; currency: string; active: boolean }>((start, end) =>
        supabase.from('financial_accounts').select('id,name,currency,active')
          .eq('user_id', user.id).in('kind', ['asset', 'liability']).order('name').order('id').range(start, end)),
    ])
    return purchase && accounts ? financeJson({ categories: [...purchase.categories, ...(purchase.archivedCategories ?? [])], accounts })
      : financeJson({ error: 'RECURRING_OPTIONS_FAILED' }, 500)
  }
  const { data, error } = service
    ? await supabase.rpc('read_recurring_service_history', { p_id: service })
    : occurrence ? await supabase.rpc('read_recurring_candidates', { p_id: occurrence, p_transaction: transaction })
      : await supabase.rpc('read_recurring_month', { p_month: month + '-01', p_home: false })
  if (error && ['PGRST202', '42883'].includes(error.code)) return financeJson({ error: 'RECURRING_MIGRATION_REQUIRED' }, 503)
  if (error) return financeRpcError(error, 'RECURRING_READ_FAILED')
  return data === null ? financeJson({ error: 'RECURRING_NOT_FOUND' }, 404) : financeJson(data)
}

export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null)
  if (!input || !isUuid(input.id)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  if (input.action === 'save' && Number.isInteger(input.expected) && input.expected >= 0
    && input.expected < 2147483647 && input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)) {
    const { data, error } = await supabase.rpc('save_recurring_service', { p_id: input.id, p_expected: input.expected, p_input: input.settings })
    return error ? financeRpcError(error, 'RECURRING_SAVE_FAILED') : financeJson(data)
  }
  if (input.action === 'read_alert') {
    const { error } = await supabase.rpc('read_recurring_alert', { p_id: input.id })
    return error ? financeRpcError(error, 'RECURRING_ALERT_FAILED') : financeJson({ saved: true })
  }
  if (['link', 'unlink', 'skip', 'restore'].includes(input.action) && input.confirmed === true
    && (['link', 'unlink'].includes(input.action) ? isUuid(input.transaction_id) : input.transaction_id == null)
    && (input.action !== 'link' || typeof input.final === 'boolean')) {
    const { error } = await supabase.rpc('change_recurring_occurrence', {
      p_id: input.id, p_action: input.action, p_transaction: input.transaction_id ?? null, p_final: input.final ?? false,
    })
    return error ? financeRpcError(error, 'RECURRING_LINK_FAILED') : financeJson({ saved: true })
  }
  return financeJson({ error: 'INVALID_INPUT' }, 400)
}
