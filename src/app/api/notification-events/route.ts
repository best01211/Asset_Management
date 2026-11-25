import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reply(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function authenticate(request: NextRequest) {
  const header = request.headers.get('authorization')
  const token = header?.match(/^Bearer ([^\s,]+)$/i)?.[1]
  if (header !== null && !token) return { response: reply({ error: 'UNAUTHORIZED' }, 401) }

  const supabase = await createClient(token)
  if (!supabase) return { response: reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503) }

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return { response: reply({ error: 'UNAUTHORIZED' }, 401) }
  return { supabase }
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return reply({ error: 'INVALID_JSON' }, 400)
  }

  if (!object(body) || Object.keys(body).some((key) =>
    !['device_event_id', 'source_package', 'received_at', 'extraction'].includes(key))
    || typeof body.device_event_id !== 'string'
    || !body.device_event_id.trim() || body.device_event_id.length > 200
    || typeof body.source_package !== 'string' || body.source_package.length > 200
    || typeof body.received_at !== 'string' || !timestamp.test(body.received_at)
    || !object(body.extraction)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const { supabase, response } = await authenticate(request)
  if (!supabase) return response

  const { data, error } = await supabase.rpc('ingest_notification_event', {
    p_device_event_id: body.device_event_id,
    p_source_package: body.source_package,
    p_received_at: body.received_at,
    p_extraction: body.extraction,
  })
  if (error?.message === 'NOTIFICATION_EVENT_CONFLICT') {
    return reply({ error: 'NOTIFICATION_EVENT_CONFLICT' }, 409)
  }
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  if (error) return reply({ error: 'NOTIFICATION_INGESTION_FAILED' }, 500)
  return reply(data)
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const beforeReceivedAt = params.get('before_received_at')
  const beforeId = params.get('before_id')
  const limitValue = params.get('limit') ?? '50'
  if ((beforeReceivedAt === null) !== (beforeId === null)
    || (beforeReceivedAt !== null && !timestamp.test(beforeReceivedAt))
    || (beforeId !== null && !uuid.test(beforeId))
    || !/^(?:[1-9]\d?|100)$/.test(limitValue)) {
    return reply({ error: 'INVALID_INPUT' }, 400)
  }

  const { supabase, response } = await authenticate(request)
  if (!supabase) return response

  const limit = Number(limitValue)
  const { data, error } = await supabase.rpc('list_notification_recovery', {
    p_before_received_at: beforeReceivedAt,
    p_before_id: beforeId,
    p_limit: limit + 1,
  })
  if (error?.code.startsWith('22')) return reply({ error: 'INVALID_INPUT' }, 400)
  if (error || !Array.isArray(data)) return reply({ error: 'NOTIFICATION_RECOVERY_FAILED' }, 500)

  const last = data.length > limit ? data[limit - 1] : null
  return reply({
    events: data.slice(0, limit),
    next_cursor: last ? { before_received_at: last.received_at, before_id: last.event_id } : null,
  })
}
