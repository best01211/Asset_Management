import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { approvalInput, approveExpense, isUuid } from '@/lib/supabase/pending-expenses'
import type { ApprovalInput } from '@/lib/supabase/pending-expenses'
import { approvalBatchLimit } from '@/lib/transaction-review'

type BatchInput = ApprovalInput & { id: string }
const noStore = { 'Cache-Control': 'no-store' }

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400, headers: noStore })
  }
  const items = body && typeof body === 'object' && 'items' in body ? body.items : null
  if (!Array.isArray(items) || items.length < 1 || items.length > approvalBatchLimit
    || !items.every((item): item is BatchInput => isUuid(item?.id) && approvalInput(item))
    || new Set(items.map((item) => item.id.toLowerCase())).size !== items.length
    || new Set(items.map((item) => item.idempotency_key.toLowerCase())).size !== items.length) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers: noStore })
  }

  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503, headers: noStore })
  const { data: session, error } = await supabase.auth.getUser()
  if (error || !session.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: noStore })

  // Each RPC commits independently so one conflict cannot roll back other approvals.
  const settled = await Promise.allSettled(items.map((item) => approveExpense(supabase, item.id, item)))
  const results = settled.map((result, index) => result.status === 'fulfilled'
    ? { id: items[index].id, ...result.value }
    : { id: items[index].id, status: 500, body: { error: 'APPROVAL_FAILED' } })
  return NextResponse.json({ results }, { headers: noStore })
}
