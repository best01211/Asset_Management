import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isUuid, validVersion } from '@/lib/supabase/pending-expenses'
import { paymentMethods } from '@/lib/transaction-review'

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const headers = { 'Cache-Control': 'no-store' }

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400, headers })
  }
  const input = body as Record<string, unknown> | null
  if (!isUuid(id) || !input || !validVersion(input.expected_version)
    || typeof input.merchant !== 'string' || !input.merchant.trim() || input.merchant.trim().length > 200
    || typeof input.amount_minor !== 'string' || !/^[1-9]\d{0,18}$/.test(input.amount_minor)
    || BigInt(input.amount_minor) > 9223372036854775807n
    || typeof input.occurred_at !== 'string' || !timestamp.test(input.occurred_at) || !Number.isFinite(Date.parse(input.occurred_at))
    || !paymentMethods.some((method) => method === input.payment_method)
    || !isUuid(input.payment_account_id) || !isUuid(input.category_id)) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
  }

  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503, headers })
  const { data: session, error: authError } = await supabase.auth.getUser()
  if (authError || !session.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers })

  const { data, error } = await supabase.rpc('edit_pending_expense', {
    p_pending_id: id,
    p_expected_version: input.expected_version,
    p_merchant: input.merchant.trim(),
    p_amount_minor: input.amount_minor,
    p_occurred_at: input.occurred_at,
    p_payment_method: input.payment_method,
    p_payment_account_id: input.payment_account_id,
    p_category_id: input.category_id,
  })
  if (error?.message === 'PENDING_NOT_FOUND') return NextResponse.json({ error: error.message }, { status: 404, headers })
  if (error?.message === 'STALE_OR_NOT_REVIEWABLE') return NextResponse.json({ error: error.message }, { status: 409, headers })
  if (error?.message === 'ACCOUNT_CATEGORY_MISMATCH' || error?.message === 'PENDING_SPLIT_AMOUNT_MISMATCH') {
    return NextResponse.json({ error: error.message }, { status: 422, headers })
  }
  if (error?.code.startsWith('22')) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
  if (error) return NextResponse.json({ error: 'PENDING_EDIT_FAILED' }, { status: 500, headers })
  return NextResponse.json(data, { headers })
}
