import { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { isUuid } from '@/lib/supabase/pending-expenses'

function amount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)
}

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month')
  if (!isBudgetMonth(month)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('list_card_statements', { p_month: month + '-01' })
  return error ? financeRpcError(error, 'CARD_STATEMENTS_READ_FAILED') : financeJson({ statements: data })
}

export async function POST(request: NextRequest) {
  let input: Record<string, unknown> | null
  try { input = await request.json() } catch { return financeJson({ error: 'INVALID_JSON' }, 400) }
  if (!input || (input.action !== 'register' && input.action !== 'allocate')) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  if (input.action === 'allocate') {
    if (!isUuid(input.statement_id) || !isUuid(input.payment_id) || !amount(input.amount_minor)) {
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    }
    const { data, error } = await supabase.rpc('allocate_card_statement_payment', {
      p_statement_id: input.statement_id, p_payment_id: input.payment_id, p_amount_minor: input.amount_minor,
    })
    return error ? financeRpcError(error, 'CARD_PAYMENT_ALLOCATION_FAILED') : financeJson(data)
  }
  const { card_id, month, due_on, billed_minor, benefit_minor, source } = input
  if (!isUuid(card_id) || !isBudgetMonth(month) || typeof due_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due_on)
    || !amount(billed_minor) || (benefit_minor != null && !amount(benefit_minor))
    || typeof source !== 'string' || !source.trim() || source.trim().length > 200) {
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  }
  const { data, error } = await supabase.rpc('register_card_statement', {
    p_card_id: card_id, p_month: month + '-01', p_due_on: due_on, p_billed_minor: billed_minor,
    p_benefit_minor: benefit_minor ?? null, p_source: source,
  })
  return error ? financeRpcError(error, 'CARD_STATEMENT_REGISTER_FAILED') : financeJson({ id: data })
}
