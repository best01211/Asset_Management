import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { refreshMarket } from '@/lib/investment-market'
import { marketInstruments } from '@/lib/market-instruments'
import type { Book } from '@/lib/investment-book'
export async function GET(req: Request) {
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const asset = new URL(req.url).searchParams.get('asset')
  if (asset && asset !== 'analysis' && !/^[A-Z0-9][A-Z0-9.:-]{0,39}\|[A-Z]{3}$/.test(asset))
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { data, error } = await supabase.rpc('read_investment_workspace', { p_history_key: asset })
  return error ? financeRpcError(error, 'INVESTMENTS_READ_FAILED') : financeJson(data)
}
export async function POST(req: Request) {
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return financeJson({ error: 'INVALID_INPUT' }, 400)
  if (body.action === 'refresh') {
    const { data, error } = await supabase.rpc('read_investment_workspace')
    if (error) return financeRpcError(error, 'INVESTMENTS_READ_FAILED')
    const book: Book = data
    const latest = new Map(book.quotes.map((q) => [q.key, q]))
    const result = await refreshMarket(marketInstruments(book))
    for (const q of result.quotes) {
      const old = latest.get(q.key)
      if (
        old &&
        Date.parse(old.at) === Date.parse(q.at) &&
        Number(old.value) === Number(q.value) &&
        old.source === q.source
      )
        continue
      const { error: writeError } = await supabase.rpc('save_investment_quote', {
        p_key: q.key,
        p_as_of: q.at,
        p_value: q.value,
        p_source: q.source,
      })
      if (writeError) return financeRpcError(writeError, 'INVESTMENTS_WRITE_FAILED')
    }
    return financeJson(result)
  }
  let result
  if (body.action === 'account' && typeof body.name === 'string')
    result = await supabase.rpc('register_investment_account', { p_name: body.name })
  else if (body.action === 'quote' && body.quote) {
    const q = body.quote
    if (typeof q.key !== 'string' || !Intl.supportedValuesOf('currency').includes(q.key.split('|')[1]))
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    result = await supabase.rpc('save_investment_quote', {
      p_key: q.key,
      p_as_of: q.at,
      p_value: q.value,
      p_source: q.source,
    })
  } else if (body.action === 'event' && body.entry && isUuid(body.entry.id) && isUuid(body.request)) {
    const { id, version, legacy: ignoredLegacy, ...payload } = body.entry
    const currencies = Intl.supportedValuesOf('currency')
    if (
      !currencies.includes(payload.currency) ||
      (payload.kind === 'fx' && !currencies.includes(payload.target))
    )
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    void ignoredLegacy
    result = await supabase.rpc('save_investment_revision', {
      p_id: id,
      p_version: version,
      p_request: body.request,
      p_data: { ...payload, new: body.create === true },
    })
  } else return financeJson({ error: 'INVALID_INPUT' }, 400)
  return result.error ? financeRpcError(result.error, 'INVESTMENTS_WRITE_FAILED') : financeJson({ ok: true })
}
