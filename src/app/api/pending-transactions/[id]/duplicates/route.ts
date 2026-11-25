import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isUuid, validVersion } from '@/lib/supabase/pending-expenses'
import { duplicateActions } from '@/lib/transaction-review'

function respond(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authorize() {
  const supabase = await createClient()
  if (!supabase) return { response: respond({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { response: respond({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase }
}

function operationError(message: string) {
  if (message === 'PENDING_NOT_FOUND') return respond({ error: message }, 404)
  if (message === 'STALE_OR_NOT_REVIEWABLE') return respond({ error: message }, 409)
  if (message === 'DUPLICATE_REFERENCE_INVALID') return respond({ error: message }, 422)
  if (message === 'INVALID_INPUT') return respond({ error: message }, 400)
  return respond({ error: 'DUPLICATE_REVIEW_FAILED' }, 500)
}

type Context = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params
  if (!isUuid(id)) return respond({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('list_pending_duplicate_candidates', { p_pending_id: id })
  return error ? operationError(error.message) : respond(data)
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params
  let body: unknown
  try { body = await request.json() } catch { return respond({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!isUuid(id) || !input || !validVersion(input.expected_version)
    || !duplicateActions.some((action) => action === input.action)
    || (input.action === 'flag' ? !isUuid(input.reference_id) : input.reference_id != null)) {
    return respond({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('review_pending_duplicate', {
    p_pending_id: id, p_expected_version: input.expected_version,
    p_action: input.action, p_reference_id: input.reference_id ?? null,
  })
  return error ? operationError(error.message) : respond(data)
}
