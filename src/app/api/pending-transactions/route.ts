import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { reviewStatuses } from '@/lib/transaction-review'
import type { ReviewTransaction } from '@/lib/transaction-review'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' }
  const params = request.nextUrl.searchParams
  const status = params.get('status') ?? 'pending_review'
  const before = params.get('before_occurred_at')
  const beforeId = params.get('before_id')
  const pageSize = params.get('limit') ?? '25'
  const id = params.get('id')
  const search = params.get('q')?.trim() ?? ''

  if (!reviewStatuses.some((value) => value === status)
    || (before === null) !== (beforeId === null)
    || (before !== null && (!timestamp.test(before) || !Number.isFinite(Date.parse(before))))
    || (beforeId !== null && !uuid.test(beforeId))
    || (id !== null && !isUuid(id)) || search.length > 200
    || !/^(?:[1-9]\d?|100)$/.test(pageSize)) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
  }

  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503, headers })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers })

  if (params.get('count') === 'review') {
    const { count, error } = await supabase.from('pending_transactions').select('id', { head: true, count: 'exact' })
      .eq('user_id', user.id).in('status', ['pending_review', 'duplicate_suspected'])
    return error ? NextResponse.json({ error: 'TRANSACTION_COUNT_FAILED' }, { status: 500, headers })
      : NextResponse.json({ count }, { headers })
  }

  const limit = Number(pageSize)
  let query = supabase.from('pending_transactions').select(
    'id,merchant,amount_minor::text,currency,occurred_at,payment_method,payment_account_id,category_id,status,version,confirmed_transaction_id,' +
    'account:financial_accounts!pending_transactions_user_id_payment_account_id_fkey(name),' +
    'category:categories!pending_transactions_user_id_category_id_fkey(name),' +
    'allocations:pending_purchase_splits!pending_purchase_splits_user_id_pending_id_fkey(category_id)',
  ).eq('user_id', user.id)
    .order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
  query = id ? query.eq('id', id) : query.eq('status', status)
  if (search) query = query.ilike('merchant', '%' + search.replace(/[\\%_*]/g, '\\$&') + '%')

  if (before !== null && beforeId !== null) {
    query = query.or('occurred_at.lt."' + before + '",and(occurred_at.eq."' + before + '",id.lt.' + beforeId + ')')
  }

  const { data, error } = await query.overrideTypes<ReviewTransaction[], { merge: false }>()
  if (error?.code.startsWith('22')) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
  if (error || !data) return NextResponse.json({ error: 'TRANSACTION_LIST_FAILED' }, { status: 500, headers })

  const last = data.length > limit ? data[limit - 1] : null
  return NextResponse.json({
    transactions: data.slice(0, limit),
    next_cursor: last ? { before_occurred_at: last.occurred_at, before_id: last.id } : null,
  }, { headers })
}

export async function POST(request: NextRequest) {
  let b: Record<string, unknown> | null
  try { b = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }
  if (!b || typeof b.merchant !== 'string' || !b.merchant.trim()
      || typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor <= 0
      || typeof b.occurred_at !== 'string' || !Number.isFinite(Date.parse(b.occurred_at))
      || typeof b.payment_method !== 'string' || !['credit_card','debit_card','cash'].includes(b.payment_method)
      || !isUuid(b.payment_account_id) || !isUuid(b.category_id)
      || (b.request_id != null && (!isUuid(b.request_id) || b.notification_event_id != null))
      || (b.notification_event_id != null && !isUuid(b.notification_event_id))) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503 })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  const input = {
    p_merchant: b.merchant, p_amount_minor: b.amount_minor,
    p_occurred_at: b.occurred_at, p_payment_method: b.payment_method,
    p_payment_account_id: b.payment_account_id, p_category_id: b.category_id,
  }
  const { data, error } = b.request_id
    ? await supabase.rpc('create_manual_pending_expense', { ...input, p_request_id: b.request_id })
    : await supabase.rpc('create_pending_expense', { ...input, p_notification_event_id: b.notification_event_id ?? null })
  if (error?.message === 'MANUAL_REQUEST_CONFLICT') return NextResponse.json({ error: error.message }, { status: 409 })
  if (error) return NextResponse.json({ error: 'CREATE_PENDING_FAILED' }, { status: 422 })
  if (b.request_id) return NextResponse.json(data, { status: data.replayed ? 200 : 201 })
  return NextResponse.json({ pending_transaction_id: data, status: 'pending_review' }, { status: 201 })
}
