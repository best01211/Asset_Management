import { NextRequest, NextResponse } from 'next/server'
import { activityTypes } from '@/lib/account-activity'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { purchaseOptions } from '@/lib/supabase/purchase-options'

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

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

export async function GET(request: NextRequest) {
  const purchaseId = request.nextUrl.searchParams.get('purchase_id')
  if (purchaseId !== null && !isUuid(purchaseId)) return reply({ error: 'INVALID_INPUT' }, 400)
  const { supabase, userId, response } = await authorize()
  if (!supabase) return response

  const [accounts, checks, purchase, options] = await Promise.all([
    supabase.rpc('list_account_balances'),
    supabase.rpc('list_account_balance_checks', { p_limit: 30 }),
    purchaseId === null ? { data: null, error: null }
      : supabase.rpc('get_purchase_refund_details', { p_transaction_id: purchaseId }),
    purchaseOptions(supabase, userId),
  ])
  if (accounts.error || checks.error || purchase.error || !options) return reply({ error: 'ACCOUNT_ACTIVITY_LIST_FAILED' }, 500)
  if (purchaseId !== null && !purchase.data) return reply({ error: 'ORIGINAL_PURCHASE_NOT_FOUND' }, 404)
  return reply({ accounts: accounts.data, checks: checks.data, purchase: purchase.data, categories: options.categories })
}

const errors: Record<string, number> = {
  ACCOUNT_NOT_FOUND: 404,
  ORIGINAL_PURCHASE_NOT_FOUND: 404,
  BALANCE_CHECK_REQUEST_CONFLICT: 409,
  MOVEMENT_REQUEST_CONFLICT: 409,
  OPENING_BALANCE_REQUIRED: 422,
  REFUND_BEFORE_PURCHASE: 422,
  REFUND_EXCEEDS_REMAINING: 422,
  REFUND_CATEGORY_UNSUPPORTED: 422,
  PURCHASE_ALREADY_REVERSED: 409,
  PURCHASE_HAS_REFUNDS: 409,
  MOVEMENT_ACCOUNT_MISMATCH: 422,
  FEE_CATEGORY_INVALID: 422,
  BALANCE_CHECK_NOT_FOUND: 404,
  BALANCE_CHECK_STALE: 409,
  NO_BALANCE_DIFFERENCE: 422,
  ADJUSTMENT_AMOUNT_OUT_OF_RANGE: 422,
}

function rpcError(error: { message: string; code: string }) {
  if (Object.hasOwn(errors, error.message)) return reply({ error: error.message }, errors[error.message])
  if (error.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  return reply({ error: 'ACCOUNT_ACTIVITY_WRITE_FAILED' }, 500)
}

export async function POST(request: NextRequest) {
  let body: unknown
  try { body = await request.json() } catch { return reply({ error: 'INVALID_JSON' }, 400) }
  const input = body as Record<string, unknown> | null
  if (input?.kind === 'purchase_reversal') {
    if (!isUuid(input.original_purchase_id) || typeof input.reason !== 'string'
      || !input.reason.trim() || input.reason.trim().length > 200) return reply({ error: 'INVALID_INPUT' }, 400)
    const { supabase, response } = await authorize()
    if (!supabase) return response
    const { data, error } = await supabase.rpc('reverse_confirmed_purchase', {
      p_purchase_id: input.original_purchase_id, p_reason: input.reason.trim(),
    })
    return error ? rpcError(error) : reply(data)
  }
  if (input?.kind === 'balance_adjustment') {
    if (!isUuid(input.balance_check_id)) return reply({ error: 'INVALID_INPUT' }, 400)
    const { supabase, response } = await authorize()
    if (!supabase) return response
    const { data, error } = await supabase.rpc('approve_balance_adjustment', { p_balance_check_id: input.balance_check_id })
    return error ? rpcError(error) : reply(data)
  }
  if (!input || !activityTypes.some((type) => type === input.kind) || !isUuid(input.request_id)
    || typeof input.at !== 'string' || !timestamp.test(input.at) || !Number.isFinite(Date.parse(input.at))
    || typeof input.amount_minor !== 'string' || !/^(?:0|-?[1-9]\d{0,18})$/.test(input.amount_minor)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const amount = BigInt(input.amount_minor)
  const check = input.kind === 'balance_check'
  if (amount > 9223372036854775807n || amount < -9223372036854775808n
    || (check ? !isUuid(input.account_id) : amount <= 0n)
    || (input.kind === 'purchase_refund' && !isUuid(input.original_purchase_id))
    || (!check && input.kind !== 'purchase_refund' && (!isUuid(input.from_account_id) || !isUuid(input.to_account_id)))) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }
  const fee = input.fee_minor ?? '0'
  const feeCategory = input.fee_category_id ?? null
  if (input.kind === 'own_transfer' && (typeof fee !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(fee)
    || BigInt(fee) > 9223372036854775807n || (fee === '0' ? feeCategory !== null : !isUuid(feeCategory)))) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const { supabase, response } = await authorize()
  if (!supabase) return response
  const { data, error } = check
    ? await supabase.rpc('record_account_balance_check', {
      p_account_id: input.account_id, p_actual_minor: input.amount_minor, p_observed_at: input.at, p_request_id: input.request_id,
    })
    : input.kind === 'own_transfer' ? await supabase.rpc('post_own_transfer_with_fee', {
      p_amount_minor: input.amount_minor, p_occurred_at: input.at, p_request_id: input.request_id,
      p_from_account_id: input.from_account_id, p_to_account_id: input.to_account_id,
      p_fee_minor: fee, p_fee_category_id: feeCategory,
    }) : await supabase.rpc('post_account_movement', {
      p_kind: input.kind, p_amount_minor: input.amount_minor, p_occurred_at: input.at, p_request_id: input.request_id,
      p_from_account_id: input.kind === 'purchase_refund' ? null : input.from_account_id,
      p_to_account_id: input.kind === 'purchase_refund' ? null : input.to_account_id,
      p_original_purchase_id: input.kind === 'purchase_refund' ? input.original_purchase_id : null,
    })
  return error ? rpcError(error) : reply(data)
}
