import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { purchaseOptions } from '@/lib/supabase/purchase-options'
import { createClient } from '@/lib/supabase/server'

function respond(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authorize() {
  const supabase = await createClient()
  if (!supabase) return { response: respond({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { response: respond({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase, userId: data.user.id }
}

export async function GET() {
  const { supabase, userId, response } = await authorize()
  if (!supabase) return response
  const [rules, options] = await Promise.all([
    supabase.from('merchant_category_rules').select('id,merchant,category_id').eq('user_id', userId).order('merchant'),
    purchaseOptions(supabase, userId),
  ])
  return rules.error || !options ? respond({ error: 'RULES_READ_FAILED' }, 500)
    : respond({ rules: rules.data, categories: options.categories })
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return respond({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || (input.action !== 'match' && input.action !== 'suggest' && input.action !== 'save') || typeof input.merchant !== 'string'
    || !input.merchant.trim() || input.merchant.trim().length > 200
    || (input.action === 'suggest' && input.memo != null && (typeof input.memo !== 'string' || input.memo.length > 1000))
    || (input.action === 'save' && input.category_id !== null && !isUuid(input.category_id))) {
    return respond({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  if (input.action === 'suggest') {
    const { data, error } = await supabase.rpc('suggest_expense_category', { p_merchant: input.merchant, p_memo: input.memo ?? null })
    if (!error) return respond(data)
    if (!['PGRST202', '42883'].includes(error.code)) return respond({ error: 'RULE_MATCH_FAILED' }, 500)
  }
  if (input.action === 'match' || input.action === 'suggest') {
    const { data, error } = await supabase.rpc('match_merchant_category', { p_merchant: input.merchant })
    return error ? respond({ error: 'RULE_MATCH_FAILED' }, 500) : respond({ category_id: data, source: 'merchant_rule' })
  }
  const { data, error } = await supabase.rpc('save_merchant_category_rule', {
    p_merchant: input.merchant, p_category_id: input.category_id,
  })
  if (error?.message === 'RULE_CATEGORY_NOT_FOUND') return respond({ error: error.message }, 404)
  return error ? respond({ error: 'RULE_SAVE_FAILED' }, 500) : respond({ id: data })
}
