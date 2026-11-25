import { NextRequest, NextResponse } from 'next/server'
import { PurchaseCsvError, readPurchaseCsv } from '@/lib/purchase-csv'
import { createClient } from '@/lib/supabase/server'

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  if (request.headers.get('Content-Type')?.split(';')[0].toLowerCase().trim() !== 'text/csv') {
    return reply({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
  }
  const supabase = await createClient()
  if (!supabase) return reply({ error: 'SUPABASE_NOT_CONFIGURED' }, 503)
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return reply({ error: 'UNAUTHORIZED' }, 401)

  try {
    const rows = await readPurchaseCsv(request.body)
    const { data, error } = await supabase.rpc('import_pending_purchase_rows', { p_rows: rows })
    if (!error) return reply({ rows: data })
    if (error.message === 'CSV_ROW_REJECTED') return reply({ error: error.message, row: Number(error.details) }, 422)
    if (error.message === 'MANUAL_REQUEST_CONFLICT') return reply({ error: error.message }, 409)
    return reply({ error: 'CSV_IMPORT_FAILED' }, 500)
  } catch (error) {
    if (error instanceof PurchaseCsvError) {
      const status = error.code === 'CSV_TOO_LARGE' ? 413 : error.code === 'CSV_ROW_REJECTED' ? 422 : 400
      return reply({ error: error.code, row: error.row }, status)
    }
    return reply({ error: 'CSV_IMPORT_FAILED' }, 500)
  }
}
