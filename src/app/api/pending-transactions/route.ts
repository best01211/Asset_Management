import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function POST(request: NextRequest) {
  let b: any
  try { b = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }
  if (!b || typeof b.merchant !== 'string' || !b.merchant.trim()
      || !Number.isSafeInteger(b.amount_minor) || b.amount_minor <= 0
      || typeof b.occurred_at !== 'string' || !Number.isFinite(Date.parse(b.occurred_at))
      || !['credit_card','debit_card','cash'].includes(b.payment_method)
      || !uuid.test(b.payment_account_id || '') || !uuid.test(b.category_id || '')
      || (b.notification_event_id != null && !uuid.test(b.notification_event_id))) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  const { data, error } = await supabase.rpc('create_pending_expense', {
    p_merchant: b.merchant, p_amount_minor: b.amount_minor,
    p_occurred_at: b.occurred_at, p_payment_method: b.payment_method,
    p_payment_account_id: b.payment_account_id, p_category_id: b.category_id,
    p_notification_event_id: b.notification_event_id ?? null,
  })
  if (error) return NextResponse.json({ error: 'CREATE_PENDING_FAILED' }, { status: 422 })
  return NextResponse.json({ pending_transaction_id: data, status: 'pending_review' }, { status: 201 })
}
