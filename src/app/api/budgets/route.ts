import { NextRequest, NextResponse } from 'next/server'
import { isBudgetAmount, isBudgetMonth } from '@/lib/monthly-budget'
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
  const { data, error } = await supabase.rpc('read_budget_workspace', { p_month: month + '-01' })
  return error ? reply({ error: 'MONTHLY_BUDGET_READ_FAILED' }, 500) : reply(data)
}

export async function PUT(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !isBudgetMonth(input.month)) return reply({ error: 'INVALID_INPUT' }, 400)
  const batch = Array.isArray(input.changes)
  const raw: unknown[] = batch ? input.changes as unknown[] : [input]
  if (!raw.length || raw.length > 512 || !raw.every(isChange)
    || new Set(raw.map((change) => change.category_id?.toLowerCase() ?? null)).size !== raw.length) return reply({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const date = input.month + '-01'
  const first = raw[0]
  const { data, error } = batch
    ? await supabase.rpc('save_budget_allocations', { p_month: date, p_changes: raw })
    : await supabase.rpc('save_monthly_budget', {
      p_month: date, p_category_id: first.category_id, p_amount_minor: first.amount_minor, p_expected_version: first.expected_version,
    })
  if (error?.message === 'BUDGET_VERSION_CHANGED') return reply({ error: error.message }, 409)
  if (error?.message === 'BUDGET_CATEGORY_NOT_FOUND') return reply({ error: error.message }, 404)
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return error ? reply({ error: 'MONTHLY_BUDGET_WRITE_FAILED' }, 500) : reply(batch ? { saved: true } : data)
}

type Change = { category_id: string | null; amount_minor: string | null; expected_version: number }

function isChange(value: unknown): value is Change {
  if (!value || typeof value !== 'object') return false
  const { category_id, amount_minor, expected_version } = value as Record<string, unknown>
  return (category_id === null || isUuid(category_id))
    && typeof expected_version === 'number' && Number.isInteger(expected_version) && expected_version >= 0 && expected_version < 2147483647
    && (amount_minor === null ? expected_version > 0 : isBudgetAmount(amount_minor))
}
