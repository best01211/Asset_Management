import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export function financeJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function requireFinanceUser() {
  const supabase = await createClient()
  if (!supabase) return { response: financeJson({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { response: financeJson({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase, user }
}

export function financeRpcError(error: { message: string; code: string }, fallback: string) {
  if (error.code === 'P0002') return financeJson({ error: error.message }, 404)
  if (error.code === '23505') return financeJson({ error: error.message }, 409)
  if (error.code.startsWith('22')) return financeJson({ error: error.message === 'INVALID_INPUT' ? 'INVALID_INPUT' :
    /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_INPUT' }, 422)
  return financeJson({ error: fallback }, 500)
}
