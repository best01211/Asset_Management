import type { Quote } from './investment-book'
import type { MarketInstrument } from './market-instruments'
import { symbols } from './investment-market'

const day = 86400
const cache = new Map<string, { until: number; result: Promise<Quote[]> }>()
let windowStart = 0,
  requests = 0

async function closes(item: MarketInstrument, end: number) {
  for (const ticker of symbols(item)) {
    const url = new URL('/v8/finance/chart/' + encodeURIComponent(ticker), 'https://query1.finance.yahoo.com')
    url.search = new URLSearchParams({
      period1: String(end - 180 * day),
      period2: String(end),
      interval: '1d',
      events: 'splits',
    }).toString()
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    if (response.status === 404) continue
    if (!response.ok) return []
    const data = (await response.json()).chart?.result?.[0]
    if (
      data?.meta?.symbol?.toUpperCase() !== ticker ||
      data.meta.currency !== (item.symbol ? item.currency : 'KRW')
    )
      continue
    const prices = data.indicators?.quote?.[0]?.close
    if (!Array.isArray(prices) || !Array.isArray(data.timestamp)) continue
    const quotes: Quote[] = []
    for (const [i, open] of data.timestamp.entries()) {
      // Daily bars are timestamped at session OPEN. Use the completed session only.
      const close = open + (item.symbol ? 6.5 * 3600 : day)
      const price = prices[i]
      if (
        !Number.isSafeInteger(open) ||
        close >= end ||
        close * 1000 > Date.now() ||
        !Number.isFinite(price) ||
        price <= 0
      )
        continue
      const value = price.toFixed(8)
      if (Number(value) <= 0) continue
      quotes.push({
        key: item.symbol + '|' + item.currency,
        at: new Date(close * 1000).toISOString(),
        value,
        source: 'Yahoo Finance · 일별 종가',
      })
    }
    return quotes
  }
  return []
}

export async function marketHistory(items: MarketInstrument[], through: string) {
  const end = Date.parse(through + 'T15:00:00Z') / 1000
  const quotes: Quote[] = [],
    missing: string[] = []
  const now = Date.now()
  if (now - windowStart >= 60000) {
    requests = 0
    windowStart = now
  }
  for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key)
  async function load(item: MarketInstrument) {
    const key = JSON.stringify([item.symbol, item.currency, item.exchange, through])
    let entry = cache.get(key)
    if (!entry && requests < 120) {
      if (cache.size >= 512) cache.delete(cache.keys().next().value!)
      requests++
      entry = { until: now + 3600000, result: closes(item, end).catch(() => []) }
      cache.set(key, entry)
    }
    const result = await entry?.result
    if (result?.length) quotes.push(...result)
    else {
      if (entry) entry.until = Math.min(entry.until, now + 60000)
      missing.push(item.symbol || item.currency)
    }
  }
  for (let i = 0; i < items.length; i += 6) await Promise.all(items.slice(i, i + 6).map(load))
  return { quotes, missing }
}
