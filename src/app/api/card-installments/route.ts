import { NextRequest, NextResponse } from 'next/server'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { createClient } from '@/lib/supabase/server'

const amount = /^(?:0|[1-9]\d{0,18})$/

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !isUuid(input.purchase_id) || typeof input.version !== 'number' ||
    !Number.isInteger(input.version) || input.version < 0 || input.version > 2147483647) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const { first_month, payment_count, principal_minor, fee_minor } = input
  const clear = first_month === null
  if (clear ? payment_count !== null || principal_minor !== null || fee_minor !== null
    : !isBudgetMonth(first_month) || typeof payment_count !== 'number' || !Number.isInteger(payment_count)
    || payment_count < 2 || payment_count > 60
    || typeof principal_minor !== 'string' || !amount.test(principal_minor) || principal_minor === '0'
    || typeof fee_minor !== 'string' || !amount.test(fee_minor)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const supabase = await createClient()
  if (!supabase) return reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503)
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return reply({ error: 'UNAUTHORIZED' }, 401)
  const { data, error } = await supabase.rpc('save_card_installment_plan', {
    p_purchase_id: input.purchase_id, p_version: input.version, p_first_month: clear ? null : first_month + '-01',
    p_payment_count: payment_count, p_principal_minor: principal_minor, p_fee_minor: fee_minor,
  })
  if (!error) return reply(data)
  if (error.message === 'INSTALLMENT_PURCHASE_NOT_FOUND') return reply({ error: error.message }, 404)
  if (error.message === 'INSTALLMENT_VERSION_CONFLICT' || error.message === 'PURCHASE_ALREADY_REVERSED') {
    return reply({ error: error.message }, 409)
  }
  if (error.message === 'INSTALLMENT_MONTH_INVALID' || error.message === 'INSTALLMENT_PRINCIPAL_INVALID') {
    return reply({ error: error.message }, 422)
  }
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'INSTALLMENT_SAVE_FAILED' }, 500)
}
