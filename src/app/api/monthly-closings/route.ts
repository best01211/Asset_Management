import { NextRequest, NextResponse } from 'next/server'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { createClient } from '@/lib/supabase/server'

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

function rpcError(error: { message: string; code: string }) {
  if (error.message === 'CLOSING_VERSION_NOT_FOUND') return reply({ error: error.message }, 404)
  if (error.message === 'CLOSING_VERSION_CONFLICT') return reply({ error: error.message }, 409)
  if (error.message === 'CLOSING_MONTH_IN_PROGRESS') return reply({ error: error.message }, 422)
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'CLOSING_REQUEST_FAILED' }, 500)
}

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month')
  const input = request.nextUrl.searchParams.get('version')
  if (!isBudgetMonth(month) || (input !== null && (!/^[1-9]\d{0,9}$/.test(input) || Number(input) > 2147483647))) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('get_monthly_financial_closing', {
    p_month: month + '-01', p_version: input === null ? null : Number(input),
  })
  return error ? rpcError(error) : reply(data)
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !isBudgetMonth(input.month) || typeof input.expected_version !== 'number'
    || !Number.isInteger(input.expected_version) || input.expected_version < 0 || input.expected_version > 2147483647) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('save_monthly_financial_closing', {
    p_month: input.month + '-01', p_expected_version: input.expected_version,
  })
  return error ? rpcError(error) : reply(data)
}
