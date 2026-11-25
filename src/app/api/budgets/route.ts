import { NextRequest, NextResponse } from 'next/server'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/supabase/pending-expenses'

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authorize() {
  const supabase = await createClient()
  if (!supabase) return { response: reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { response: reply({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase }
}

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month')
  if (!isBudgetMonth(month)) return reply({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('get_monthly_budget', { p_month: month + '-01' })
  return error ? reply({ error: 'MONTHLY_BUDGET_READ_FAILED' }, 500) : reply(data)
}

export async function PUT(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !isBudgetMonth(input.month)
    || (input.category_id !== null && !isUuid(input.category_id))
    || typeof input.expected_version !== 'number' || !Number.isInteger(input.expected_version)
    || input.expected_version < 0 || input.expected_version > 2147483647
    || (input.amount_minor === null ? input.expected_version === 0
      : typeof input.amount_minor !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(input.amount_minor)
        || BigInt(input.amount_minor) > 9223372036854775807n)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('save_monthly_budget', {
    p_month: input.month + '-01', p_category_id: input.category_id,
    p_amount_minor: input.amount_minor, p_expected_version: input.expected_version,
  })
  if (error?.message === 'BUDGET_VERSION_CHANGED') return reply({ error: error.message }, 409)
  if (error?.message === 'BUDGET_CATEGORY_NOT_FOUND') return reply({ error: error.message }, 404)
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return error ? reply({ error: 'MONTHLY_BUDGET_WRITE_FAILED' }, 500) : reply(data)
}
