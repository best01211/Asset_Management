import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }
  const b = body as Record<string, unknown> | null
  if (!uuid.test(id) || !b || typeof b !== 'object'
      || typeof b.expected_version !== 'number' || !Number.isSafeInteger(b.expected_version) || b.expected_version < 1
      || typeof b.idempotency_key !== 'string' || !uuid.test(b.idempotency_key)) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  const supabase = await createClient()
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError || !authData.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  // RLS/RPC derive user from JWT; never accept a user_id in request body.
  const { data, error } = await supabase.rpc('approve_pending_expense', {
    p_pending_id: id,
    p_expected_version: Number(b.expected_version),
    p_idempotency_key: b.idempotency_key,
  })
  if (error) {
    const code = error.message.includes('STALE_OR_NOT_REVIEWABLE') ? 'STALE_OR_NOT_REVIEWABLE'
      : error.message.includes('IDEMPOTENCY_KEY_REUSED') ? 'IDEMPOTENCY_KEY_REUSED'
      : error.message.includes('PENDING_NOT_FOUND') ? 'PENDING_NOT_FOUND'
      : error.message.includes('ACCOUNT_CATEGORY_MISMATCH') ? 'ACCOUNT_CATEGORY_MISMATCH'
      : 'APPROVAL_FAILED'
    const status = code === 'PENDING_NOT_FOUND' ? 404
      : code === 'STALE_OR_NOT_REVIEWABLE' || code === 'IDEMPOTENCY_KEY_REUSED' ? 409
      : code === 'ACCOUNT_CATEGORY_MISMATCH' ? 422 : 500
    return NextResponse.json({ error: code }, { status })
  }
  return NextResponse.json(data, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
