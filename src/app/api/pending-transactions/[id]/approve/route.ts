import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { approvalInput, approveExpense, isUuid } from '@/lib/supabase/pending-expenses'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }
  if (!isUuid(id) || !approvalInput(body)) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503 })
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError || !authData.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const { status, body: result } = await approveExpense(supabase, id, body)
  return NextResponse.json(result, { status, headers: { 'Cache-Control': 'no-store' } })
}
