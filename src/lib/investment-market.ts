import type { Quote } from './investment-book'
import type { MarketInstrument } from './market-instruments'

const cache = new Map<string, { expires: number; result: Promise<Quote | null> }>()
const minute = 60000
let windowStart = 0,
  attempts = 0
const usMarkets = new Set([
  'NASDAQ',
  'XNAS',
  'NYSE',
  'XNYS',
  'NYSE ARCA',
  'ARCX',
  'AMEX',
  'NYSEAMERICAN',
  'BATS',
])

export function symbols({ symbol, currency, exchange }: MarketInstrument): string[] {
  if (!symbol) return currency === 'KRW' ? [] : [currency + 'KRW=X']
  const parts = symbol.split(':')
  if (parts.length > 2) return []
  const ticker = parts.at(-1)!
  const market = (parts.length === 2 ? parts[0] : exchange).trim().toUpperCase()
  if (currency === 'KRW' && /^[A-Z0-9]{6}$/.test(ticker)) {
    if (market === 'KOSDAQ') return [ticker + '.KQ']
    if (['', 'KRX', 'XKRX', 'KOSPI'].includes(market))
      return market === 'KOSPI' ? [ticker + '.KS'] : [ticker + '.KS', ticker + '.KQ']
  }
  if (currency === 'USD' && (!market || usMarkets.has(market)) && /^[A-Z0-9.-]{1,20}$/.test(ticker))
    return [ticker.replaceAll('.', '-')]
  return []
}
async function query(instrument: MarketInstrument): Promise<Quote | null> {
  for (const ticker of symbols(instrument)) {
    const url = new URL('/v8/finance/chart/' + encodeURIComponent(ticker), 'https://query1.finance.yahoo.com')
    url.search = new URLSearchParams({ interval: '1d', range: '1d' }).toString()
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) })
    if (res.status === 404) continue
    if (!res.ok) return null
    const m = (await res.json()).chart?.result?.[0]?.meta
    if (
      !m ||
      m.symbol?.toUpperCase() !== ticker ||
      m.currency !== (instrument.symbol ? instrument.currency : 'KRW')
    )
      continue
    if (
      typeof m.regularMarketPrice !== 'number' ||
      !Number.isFinite(m.regularMarketPrice) ||
      m.regularMarketPrice <= 0 ||
      !Number.isSafeInteger(m.regularMarketTime) ||
      m.regularMarketTime <= 0 ||
      m.regularMarketTime * 1000 > Date.now() + 1000
    )
      continue
    const value = m.regularMarketPrice.toFixed(8).replace(/\.?0+$/, '')
    if (Number(value) <= 0) continue
    return {
      key: instrument.symbol + '|' + instrument.currency,
      value,
      at: new Date(m.regularMarketTime * 1000).toISOString(),
      source: 'Yahoo Finance · ' + (instrument.symbol ? '거래소 최신가' : '외환 참고환율'),
    }
  }
  return null
}
function cached(instrument: MarketInstrument) {
  const key = JSON.stringify([instrument.symbol, instrument.currency, instrument.exchange.toUpperCase()]),
    now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.result
  if (now - windowStart >= minute) {
    attempts = 0
    windowStart = now
  }
  if (attempts >= 120) return Promise.resolve(null)
  attempts++
  if (cache.size >= 512) for (const [id, item] of cache) if (item.expires <= now) cache.delete(id)
  const result = query(instrument).catch(() => null)
  cache.set(key, { expires: now + minute, result })
  return result
}
export async function refreshMarket(instruments: MarketInstrument[]) {
  const quotes: Quote[] = [],
    missing: string[] = []
  for (let i = 0; i < instruments.length; i += 6) {
    const batch = instruments.slice(i, i + 6)
    const values = await Promise.all(batch.map(cached))
    values.forEach((q, index) => {
      if (q) quotes.push(q)
      else missing.push(batch[index].symbol || batch[index].currency)
    })
  }
  return {
    quotes,
    missing,
    message: !instruments.length
      ? '갱신할 보유 자산이 없습니다.'
      : '외부 시세 ' +
        quotes.length +
        '건 확인' +
        (missing.length ? ' · 조회 실패 ' + missing.join(', ') + ' (마지막 값 유지)' : ' · Yahoo Finance'),
  }
}
