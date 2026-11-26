import type { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { loadHistoryDetails } from '@/lib/supabase/transaction-history'

type Context = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params
  if (!isUuid(id)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  try {
    const result = await loadHistoryDetails(supabase, user.id, id)
    return result ? financeJson(result) : financeJson({ error: 'TRANSACTION_NOT_FOUND' }, 404)
  } catch {
    return financeJson({ error: 'TRANSACTION_DETAILS_FAILED' }, 500)
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params
  const input = await request.json().catch(() => null)
  if (!isUuid(id) || !input || typeof input.memo !== 'string' || [...input.memo].length > 1000
    || !Array.isArray(input.tags) || input.tags.length > 10
    || input.tags.some((tag: unknown) => typeof tag !== 'string' || !tag.trim() || [...tag.trim()].length > 24)
    || !Number.isInteger(input.version) || input.version < 0 || input.version >= 2147483647)
    return financeJson({ error: 'INVALID_INPUT' }, 400)

  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('save_transaction_annotation', {
    p_id: id, p_version: input.version, p_memo: input.memo, p_tags: [...new Set<string>(input.tags.map((tag: string) => tag.trim()))],
  })
  return error ? financeRpcError(error, 'ANNOTATION_SAVE_FAILED') : financeJson(data)
}
