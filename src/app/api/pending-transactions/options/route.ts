import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { purchaseOptions } from '@/lib/supabase/purchase-options'

const headers = { 'Cache-Control': 'no-store' }

export async function GET() {
  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503, headers })
  const { data: session, error } = await supabase.auth.getUser()
  if (error || !session.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers })

  const result = await purchaseOptions(supabase, session.user.id)
  return result
    ? NextResponse.json(result, { headers })
    : NextResponse.json({ error: 'PURCHASE_OPTIONS_FAILED' }, { status: 500, headers })
}
