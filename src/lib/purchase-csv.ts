import { isUuid } from '@/lib/supabase/pending-expenses'
import { paymentMethods } from '@/lib/transaction-review'

const header = ['merchant', 'amount_minor', 'occurred_at', 'payment_method', 'payment_account_id', 'category_id']
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const bytesLimit = 128 * 1024
const rowsLimit = 100

export class PurchaseCsvError extends Error {
  constructor(public code: string, public row?: number) {
    super(code)
  }
}

async function readCsv(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new PurchaseCsvError('INVALID_CSV')
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > bytesLimit) {
        await reader.cancel()
        throw new PurchaseCsvError('CSV_TOO_LARGE')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    if (error instanceof PurchaseCsvError) throw error
    throw new PurchaseCsvError('INVALID_CSV')
  } finally {
    reader.releaseLock()
  }
}

function records(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let state: 'plain' | 'quoted' | 'closed' = 'plain'

  function endField() {
    row.push(field)
    field = ''
  }

  function endRow() {
    endField()
    rows.push(row)
    if (rows.length > rowsLimit + 1) throw new PurchaseCsvError('CSV_TOO_MANY_ROWS')
    row = []
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (state === 'quoted') {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else state = 'closed'
      continue
    }
    if (char === ',') {
      endField()
      state = 'plain'
    } else if (char === '\n' || char === '\r') {
      endRow()
      state = 'plain'
      if (char === '\r' && text[index + 1] === '\n') index++
    } else if (state === 'closed' || (char === '"' && field.length > 0)) {
      throw new PurchaseCsvError('INVALID_CSV', rows.length + 1)
    } else if (char === '"') state = 'quoted'
    else field += char
  }
  if (state === 'quoted') throw new PurchaseCsvError('INVALID_CSV', rows.length + 1)
  if (row.length > 0 || field.length > 0 || state === 'closed') endRow()
  return rows
}

export async function readPurchaseCsv(body: ReadableStream<Uint8Array> | null) {
  const text = await readCsv(body)
  if (text.includes('\0')) throw new PurchaseCsvError('INVALID_CSV')
  const [keys, ...rows] = records(text)
  if (keys?.length !== header.length || !header.every((key, i) => key === keys[i])) {
    throw new PurchaseCsvError('CSV_HEADER_INVALID', 1)
  }
  if (!rows.length) throw new PurchaseCsvError('CSV_EMPTY')
  return rows.map((row, index) => {
    const [merchant, amount, occurredAt, method, account, category] = row.map((cell) => cell.trim())
    if (row.length !== header.length || !merchant || merchant.length > 200 ||
      !/^[1-9]\d{0,18}$/.test(amount) || BigInt(amount) > 9223372036854775807n ||
      !timestamp.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt)) ||
      !paymentMethods.some((candidate) => candidate === method) || !isUuid(account) || !isUuid(category)) {
      throw new PurchaseCsvError('CSV_ROW_REJECTED', index + 2)
    }
    return {
      merchant: merchant.replace(/\r\n?/g, '\n'), amount_minor: amount, occurred_at: occurredAt,
      payment_method: method, payment_account_id: account.toLowerCase(), category_id: category.toLowerCase(),
    }
  })
}
