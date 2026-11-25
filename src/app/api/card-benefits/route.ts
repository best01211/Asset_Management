import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { createClient } from '@/lib/supabase/server'

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9998-12-31') return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (!input || !isUuid(input.card_id) || (input.category_id !== null && !isUuid(input.category_id))) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  if (input.action === 'register') {
    if (!isUuid(input.request_id) || !validDate(input.effective_from)
      || (input.effective_until !== null && (!validDate(input.effective_until) || input.effective_until < input.effective_from))
      || typeof input.source !== 'string' || !input.source.trim() || input.source.trim().length > 200
      || typeof input.rate_bps !== 'number' || !Number.isInteger(input.rate_bps) || input.rate_bps < 1 || input.rate_bps > 10000
      || !validAmount(input.prior_spend_minor) || (input.monthly_cap_minor !== null && !validAmount(input.monthly_cap_minor))) {
      return reply({ error: 'INVALID_INPUT' }, 400)
    }
  } else if (input.action !== 'estimate' || !validDate(input.purchase_date)
    || !validAmount(input.eligible_amount_minor) || !validAmount(input.prior_eligible_minor) || !validAmount(input.used_benefit_minor)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const supabase = await createClient()
  if (!supabase) return reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503)
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return reply({ error: 'UNAUTHORIZED' }, 401)
  const { data, error } = input.action === 'register'
    ? await supabase.rpc('register_card_benefit_terms', {
      p_card_id: input.card_id, p_request_id: input.request_id, p_effective_from: input.effective_from,
      p_effective_until: input.effective_until, p_source: input.source, p_category_id: input.category_id,
      p_rate_bps: input.rate_bps, p_prior_spend_minor: input.prior_spend_minor, p_monthly_cap_minor: input.monthly_cap_minor,
    })
    : await supabase.rpc('estimate_card_benefit', {
      p_card_id: input.card_id, p_purchase_date: input.purchase_date, p_category_id: input.category_id,
      p_eligible_amount_minor: input.eligible_amount_minor, p_prior_eligible_minor: input.prior_eligible_minor,
      p_used_benefit_minor: input.used_benefit_minor,
    })
  if (!error) return reply(input.action === 'register' ? { version: data } : data)
  if (['BENEFIT_CARD_NOT_FOUND', 'BENEFIT_CATEGORY_NOT_FOUND', 'BENEFIT_TERMS_NOT_FOUND'].includes(error.message)) {
    return reply({ error: error.message }, 404)
  }
  if (error.message === 'CARD_BENEFIT_REQUEST_CONFLICT') return reply({ error: error.message }, 409)
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'CARD_BENEFIT_FAILED' }, 500)
}
