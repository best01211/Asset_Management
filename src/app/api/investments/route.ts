import { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isUuid } from '@/lib/supabase/pending-expenses'

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('account_id')
  if (id !== null && !isUuid(id)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  if (id === null) {
    const { data, error } = await supabase.from('investment_accounts').select('id,name').eq('user_id', user.id).order('name')
    return error ? financeJson({ error: 'INVESTMENTS_READ_FAILED' }, 500) : financeJson({ accounts: data })
  }
  const { data, error } = await supabase.rpc('get_investment_account', { p_account_id: id })
  if (error) return financeRpcError(error, 'INVESTMENTS_READ_FAILED')
  return data ? financeJson(data) : financeJson({ error: 'INVESTMENT_ACCOUNT_NOT_FOUND' }, 404)
}

export async function POST(request: NextRequest) {
  let input: Record<string, unknown> | null
  try { input = await request.json() } catch { return financeJson({ error: 'INVALID_JSON' }, 400) }
  if (!input || (input.action !== 'account' && input.action !== 'event' && input.action !== 'value')) {
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  if (input.action === 'account') {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) {
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    }
    const { data, error } = await supabase.rpc('register_investment_account', { p_name: input.name })
    return error ? financeRpcError(error, 'INVESTMENT_ACCOUNT_FAILED') : financeJson({ id: data })
  }
  if (input.action === 'value') {
    if (!isUuid(input.account_id) || !Array.isArray(input.quotes) || input.quotes.length > 100) {
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    }
    const quotes = []
    for (const value of input.quotes as (Record<string, unknown> | null)[]) {
      if (!value) return financeJson({ error: 'INVALID_INPUT' }, 400)
      const { symbol, currency, unit_price, krw_per_unit, as_of, source } = value
      if (![symbol, currency, unit_price, krw_per_unit, as_of, source].every((field) => typeof field === 'string' && field.length <= 200)) {
        return financeJson({ error: 'INVALID_INPUT' }, 400)
      }
      quotes.push({ symbol, currency, unit_price, krw_per_unit, as_of, source })
    }
    const { data, error } = await supabase.rpc('value_investment_positions', { p_account_id: input.account_id, p_quotes: quotes })
    return error ? financeRpcError(error, 'INVESTMENT_VALUATION_FAILED') : financeJson(data)
  }
  if (!isUuid(input.account_id) || !isUuid(input.request_id) || !input.event || typeof input.event !== 'object' || Array.isArray(input.event)) {
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  }
  const { kind, occurred_at, symbol, currency, quantity, gross, fee, krw_per_unit, target_currency, target_amount, source } =
    input.event as Record<string, unknown>
  if (![kind, occurred_at, currency, gross, fee, krw_per_unit, source].every((value) => typeof value === 'string' && value.length <= 200)
    || ![symbol, quantity, target_currency, target_amount].every((value) => value == null || (typeof value === 'string' && value.length <= 40))) {
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  }
  const { data, error } = await supabase.rpc('record_investment_event', {
    p_account_id: input.account_id, p_request_id: input.request_id,
    p_data: { kind, occurred_at, symbol, currency, quantity, gross, fee, krw_per_unit, target_currency, target_amount, source },
  })
  return error ? financeRpcError(error, 'INVESTMENT_EVENT_FAILED') : financeJson(data)
}
