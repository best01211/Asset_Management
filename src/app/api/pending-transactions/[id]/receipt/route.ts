import { NextRequest, NextResponse } from 'next/server'
import { isUuid, validVersion } from '@/lib/supabase/pending-expenses'
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
  return { supabase }
}

const errors: Record<string, number> = {
  PENDING_NOT_FOUND: 404,
  STALE_OR_NOT_REVIEWABLE: 409,
  RECEIPT_TOTAL_MISMATCH: 422,
  RECEIPT_CATEGORY_INVALID: 422,
}

function rpcError(error: { message: string; code: string }) {
  if (Object.hasOwn(errors, error.message)) return reply({ error: error.message }, errors[error.message])
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'RECEIPT_REQUEST_FAILED' }, 500)
}

function money(value: unknown, positive = false): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) &&
    (!positive || value !== '0') && BigInt(value) <= 9223372036854775807n
}

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params
  if (!isUuid(id)) return reply({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('get_purchase_receipt', { p_pending_id: id })
  return error ? rpcError(error) : reply(data)
}

export async function PUT(request: NextRequest, context: Context) {
  const { id } = await context.params
  if (!isUuid(id)) return reply({ error: 'INVALID_INPUT' }, 400)
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !validVersion(input.expected_version)) return reply({ error: 'INVALID_INPUT' }, 400)
  const receipt = input.receipt as Record<string, unknown> | null
  let payload = null
  if (receipt !== null) {
    if (!receipt || (receipt.source !== 'manual' && receipt.source !== 'ocr_reviewed')
      || !money(receipt.shipping_minor) || !money(receipt.discount_minor) || !money(receipt.points_minor)
      || !Array.isArray(receipt.items) || receipt.items.length === 0 || receipt.items.length > 100) {
      return reply({ error: 'INVALID_INPUT' }, 400)
    }
    const items = []
    for (const item of receipt.items as (Record<string, unknown> | null)[]) {
      if (!item || typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 160
        || !isUuid(item.category_id) || !money(item.gross_minor, true) || !money(item.discount_minor)
        || BigInt(item.discount_minor) > BigInt(item.gross_minor)) {
        return reply({ error: 'INVALID_INPUT' }, 400)
      }
      items.push({
        label: item.label.trim(), category_id: item.category_id, gross_minor: item.gross_minor, discount_minor: item.discount_minor,
      })
    }
    payload = {
      source: receipt.source, shipping_minor: receipt.shipping_minor, discount_minor: receipt.discount_minor,
      points_minor: receipt.points_minor, items,
    }
  }

  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = await supabase.rpc('save_purchase_receipt', {
    p_pending_id: id, p_version: input.expected_version, p_receipt: payload,
  })
  return error ? rpcError(error) : reply(data)
}
