import type { NextRequest } from 'next/server'
import { financeJson, requireFinanceUser } from '@/lib/finance-api'
import { defaultRange, validRange } from '@/lib/transaction-history'
import { loadHistory } from '@/lib/supabase/transaction-history'

export async function GET(request: NextRequest) {
  const defaults = defaultRange()
  const from = request.nextUrl.searchParams.get('from') ?? defaults.from
  const to = request.nextUrl.searchParams.get('to') ?? defaults.to
  if (!validRange(from, to)) return financeJson({ error: 'INVALID_DATE_RANGE' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  const result = await loadHistory(supabase, user.id, from, to)
  return result ? financeJson(result) : financeJson({ error: 'TRANSACTION_LIST_FAILED' }, 500)
}
