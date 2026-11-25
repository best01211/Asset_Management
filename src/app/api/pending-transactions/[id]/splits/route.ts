import { NextRequest, NextResponse } from 'next/server'
import { isUuid, validVersion } from '@/lib/supabase/pending-expenses'
import { purchaseOptions } from '@/lib/supabase/purchase-options'
import { createClient } from '@/lib/supabase/server'

type Context = { params: Promise<{ id: string }> }

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authorize() {
  const supabase = await createClient()
  if (!supabase) return { response: reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { response: reply({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase, userId: data.user.id }
}

const errors: Record<string, number> = {
  PENDING_NOT_FOUND: 404,
  STALE_OR_NOT_REVIEWABLE: 409,
  RECEIPT_CONTROLS_SPLITS: 409,
  SPLIT_CATEGORY_INVALID: 422,
  PENDING_SPLIT_AMOUNT_MISMATCH: 422,
}

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params
  if (!isUuid(id)) return reply({ error: 'INVALID_INPUT' }, 400)
  const { supabase, userId, response } = await authorize()
  if (!supabase) return response
  const [split, options] = await Promise.all([
    supabase.rpc('get_pending_purchase_splits', { p_pending_id: id }),
    purchaseOptions(supabase, userId),
  ])
  if (split.error?.message === 'PENDING_NOT_FOUND') return reply({ error: split.error.message }, 404)
  if (split.error || !options) return reply({ error: 'SPLIT_READ_FAILED' }, 500)
  return reply({ allocations: split.data, categories: options.categories })
}

export async function PUT(request: NextRequest, context: Context) {
  const { id } = await context.params
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!isUuid(id) || !input || !validVersion(input.expected_version)
    || !Array.isArray(input.allocations) || input.allocations.length === 1 || input.allocations.length > 30
    || !input.allocations.every((item) => isUuid(item?.category_id) && typeof item.amount_minor === 'string'
      && /^[1-9]\d{0,18}$/.test(item.amount_minor) && BigInt(item.amount_minor) <= 9223372036854775807n)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('save_pending_purchase_splits', {
    p_pending_id: id, p_expected_version: input.expected_version, p_allocations: input.allocations,
  })
  if (!error) return reply(data)
  if (Object.hasOwn(errors, error.message)) return reply({ error: error.message }, errors[error.message])
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'SPLIT_SAVE_FAILED' }, 500)
}
