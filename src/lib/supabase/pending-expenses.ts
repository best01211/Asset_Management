import type { createClient } from './server'

type Supabase = NonNullable<Awaited<ReturnType<typeof createClient>>>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value)
}

export function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647
}

export type ApprovalInput = { expected_version: number; idempotency_key: string }

export function approvalInput(value: unknown): value is ApprovalInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  return validVersion(input.expected_version) && isUuid(input.idempotency_key)
}

export async function approveExpense(supabase: Supabase, id: string, input: ApprovalInput) {
  const { data, error } = await supabase.rpc('approve_pending_expense', {
    p_pending_id: id,
    p_expected_version: input.expected_version,
    p_idempotency_key: input.idempotency_key,
  })
  if (!error) return { status: 200, body: data } as const

  const message = error.message
  if (message.includes('STALE_OR_NOT_REVIEWABLE')) return { status: 409, body: { error: 'STALE_OR_NOT_REVIEWABLE' } } as const
  if (message.includes('IDEMPOTENCY_KEY_REUSED') || (error.code === '23505' && message.includes('approval_requests_pkey'))) {
    return { status: 409, body: { error: 'IDEMPOTENCY_KEY_REUSED' } } as const
  }
  if (message.includes('PENDING_NOT_FOUND')) return { status: 404, body: { error: 'PENDING_NOT_FOUND' } } as const
  if (message.includes('ACCOUNT_CATEGORY_MISMATCH')) return { status: 422, body: { error: 'ACCOUNT_CATEGORY_MISMATCH' } } as const
  return { status: 500, body: { error: 'APPROVAL_FAILED' } } as const
}
