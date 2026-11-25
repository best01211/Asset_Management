import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { purchaseOptions } from '@/lib/supabase/purchase-options'

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authorize() {
  const supabase = await createClient()
  if (!supabase) return { response: reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { response: reply({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase, userId: data.user.id }
}

export async function GET() {
  const { supabase, userId, response } = await authorize()
  if (!supabase) return response
  const data = await purchaseOptions(supabase, userId)
  return data ? reply(data) : reply({ error: 'FINANCE_SETTINGS_READ_FAILED' }, 500)
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const item = body as Record<string, unknown> | null
  if (!item || (item.type !== 'account' && item.type !== 'category') || typeof item.name !== 'string'
    || !item.name.trim() || item.name.trim().length > (item.type === 'category' ? 80 : 100)
    || (item.type === 'account' && item.kind !== 'asset' && item.kind !== 'liability')) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = item.type === 'category'
    ? await supabase.rpc('create_krw_expense_category', { p_name: item.name.trim() })
    : await supabase.rpc('create_krw_payment_account', { p_name: item.name.trim(), p_kind: item.kind })
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return error ? reply({ error: 'FINANCE_SETTINGS_WRITE_FAILED' }, 500) : reply({ id: data })
}
