import type { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isUuid } from '@/lib/supabase/pending-expenses'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const input = await request.json().catch(() => null)
  if (!isUuid(id) || !input || !isUuid(input.source_id) || !isUuid(input.current_id) || !isUuid(input.target_id)
    || input.confirmed !== true) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const { error } = await supabase.rpc('move_transaction_category', {
    p_id: id, p_source: input.source_id, p_previous: input.current_id, p_target: input.target_id,
  })
  return error ? financeRpcError(error, 'CATEGORY_MOVE_FAILED') : financeJson({ saved: true })
}
