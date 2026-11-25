import { NextRequest, NextResponse } from 'next/server'
import { ledgerCsv } from '@/lib/ledger-csv'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { createClient } from '@/lib/supabase/server'

const headers = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month')
  const kind = request.nextUrl.searchParams.get('kind')
  if (!isBudgetMonth(month) || (kind !== 'transactions' && kind !== 'entries')) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
  }
  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'SUPABASE_NOT_CONFIGURED' }, { status: 503, headers })
  const { data: session, error: authError } = await supabase.auth.getUser()
  if (authError || !session.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers })

  const { data, error } = await supabase.rpc('get_monthly_ledger_export', { p_month: month + '-01', p_kind: kind })
  if (error || !Array.isArray(data)) return NextResponse.json({ error: 'LEDGER_EXPORT_FAILED' }, { status: 500, headers })
  return new NextResponse(ledgerCsv(kind, data), { headers: {
    ...headers, 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="ledger-' + kind + '-' + month + '.csv"',
    'X-Content-Type-Options': 'nosniff',
  } })
}
