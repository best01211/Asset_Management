import { financeJson } from '@/lib/finance-api'
import { refreshMarket } from '@/lib/investment-market'
import { marketHistory } from '@/lib/investment-history'
import type { MarketInstrument } from '@/lib/market-instruments'

// Only public instrument identifiers are accepted; no account or balance information is sent upstream.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const items: MarketInstrument[] = body?.instruments
  if (
    !Array.isArray(items) ||
    items.length > 64 ||
    items.some(
      (i) =>
        !i ||
        typeof i.symbol !== 'string' ||
        !/^[A-Z0-9.:-]{0,40}$/.test(i.symbol) ||
        typeof i.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(i.currency) ||
        typeof i.exchange !== 'string' ||
        i.exchange.length > 60,
    )
  )
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  if (body.through !== undefined) {
    const through = body.through
    const parsed =
      typeof through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(through) ? Date.parse(through) : NaN
    if (
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 10) !== through ||
      parsed < 0 ||
      parsed > Date.now() + 9 * 3600000
    )
      return financeJson({ error: 'INVALID_DATE' }, 400)
    return financeJson(await marketHistory(items, through))
  }
  return financeJson(await refreshMarket(items))
}
