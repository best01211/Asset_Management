import type { NextRequest } from 'next/server'
import { financeJson, requireFinanceUser } from '@/lib/finance-api'
import { receiptBucket, receiptName, receiptSizeLimit } from '@/lib/receipt-attachment'
import { recognizeReceipt, ReceiptOcrError } from '@/lib/receipt-ocr'
import { isUuid } from '@/lib/supabase/pending-expenses'

export const runtime = 'nodejs'
export const maxDuration = 60

type Context = { params: Promise<{ id: string }> }
let processing = false

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params
  const name = request.nextUrl.searchParams.get('file')
  if (!isUuid(id) || !name || !receiptName.test(name)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  if (processing) return financeJson({ error: 'OCR_BUSY' }, 429)
  processing = true
  try {
    const { data, error } = await supabase.storage.from(receiptBucket).download(user.id + '/' + id.toLowerCase() + '/' + name)
    if (error || !data) return financeJson({ error: 'ATTACHMENT_NOT_FOUND' }, 404)
    if (data.size > receiptSizeLimit) return financeJson({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
    const pages = await recognizeReceipt(Buffer.from(await data.arrayBuffer()), name.slice(name.lastIndexOf('.') + 1))
    return financeJson({ file: name, requires_review: true, pages })
  } catch (error) {
    if (error instanceof ReceiptOcrError) return financeJson({ error: error.message }, 422)
    return financeJson({ error: 'OCR_FAILED' }, 422)
  } finally {
    processing = false
  }
}
