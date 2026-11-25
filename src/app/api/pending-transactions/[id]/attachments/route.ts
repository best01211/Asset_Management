import { NextRequest } from 'next/server'
import { financeJson, requireFinanceUser } from '@/lib/finance-api'
import { boundedAttachment, receiptBucket, receiptName, receiptTypes } from '@/lib/receipt-attachment'
import { isUuid } from '@/lib/supabase/pending-expenses'

type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params
  const name = request.nextUrl.searchParams.get('file')
  if (!isUuid(id) || (name !== null && !receiptName.test(name))) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  const folder = user.id + '/' + id.toLowerCase()
  const bucket = supabase.storage.from(receiptBucket)
  if (name === null) {
    const { data, error } = await bucket.list(folder, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } })
    if (error) return financeJson({ error: 'ATTACHMENTS_READ_FAILED' }, 500)
    return financeJson({ files: data.filter((item) => receiptName.test(item.name)).map((item) => ({ name: item.name, created_at: item.created_at })) })
  }
  const { data, error } = await bucket.download(folder + '/' + name)
  if (error || !data) return financeJson({ error: 'ATTACHMENT_NOT_FOUND' }, 404)
  return new Response(data.stream(), {
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + name + '"',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    },
  })
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params
  const fileId = request.nextUrl.searchParams.get('request_id')
  const mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? ''
  const type = receiptTypes.get(mime)
  if (!isUuid(id) || !isUuid(fileId)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  if (!type) return financeJson({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
  const { supabase, user, response } = await requireFinanceUser()
  if (!supabase) return response
  const { data: draft, error: draftError } = await supabase.rpc('get_purchase_receipt', { p_pending_id: id })
  if (draftError?.code === 'P0002') return financeJson({ error: 'PENDING_NOT_FOUND' }, 404)
  if (draftError || !draft) return financeJson({ error: 'ATTACHMENT_UPLOAD_FAILED' }, 500)
  if (draft.status !== 'pending_review' && draft.status !== 'confirmed') return financeJson({ error: 'STALE_OR_NOT_REVIEWABLE' }, 409)
  const body = await boundedAttachment(request.body).catch(() => Buffer.alloc(0))
  if (body === null) return financeJson({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
  if (!body.subarray(0, type.signature.length).equals(type.signature)) return financeJson({ error: 'INVALID_ATTACHMENT' }, 422)
  const name = fileId.toLowerCase() + '.' + type.ext
  const filePath = user.id + '/' + id.toLowerCase() + '/' + name
  const bucket = supabase.storage.from(receiptBucket)
  const { error } = await bucket.upload(filePath, body, { contentType: mime, upsert: false })
  if (!error) return financeJson({ name, replayed: false }, 201)
  const { data } = await bucket.download(filePath)
  if (!data) return financeJson({ error: 'ATTACHMENT_UPLOAD_FAILED' }, 500)
  if (Buffer.from(await data.arrayBuffer()).equals(body)) return financeJson({ name, replayed: true })
  return financeJson({ error: 'ATTACHMENT_REQUEST_CONFLICT' }, 409)
}
