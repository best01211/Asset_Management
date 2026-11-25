import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/supabase/pending-expenses'

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

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

export async function GET() {
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('list_account_balances')
  return error ? reply({ error: 'ACCOUNT_BALANCE_LIST_FAILED' }, 500) : reply({ accounts: data })
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }

  const input = body as Record<string, unknown> | null
  if (!input || !isUuid(input.account_id)
    || typeof input.amount_minor !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(input.amount_minor)
    || BigInt(input.amount_minor) > 9223372036854775807n
    || typeof input.effective_at !== 'string' || !timestamp.test(input.effective_at)
    || !Number.isFinite(Date.parse(input.effective_at))) return reply({ error: 'INVALID_INPUT' }, 400)

  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('record_account_opening_balance', {
    p_account_id: input.account_id, p_amount_minor: input.amount_minor, p_effective_at: input.effective_at,
  })
  if (error?.message === 'ACCOUNT_NOT_FOUND') return reply({ error: error.message }, 404)
  if (error?.message === 'OPENING_BALANCE_ALREADY_RECORDED') return reply({ error: error.message }, 409)
  if (error?.message === 'ACCOUNT_NOT_ELIGIBLE') return reply({ error: error.message }, 422)
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return error ? reply({ error: 'OPENING_BALANCE_FAILED' }, 500) : reply(data)
}
