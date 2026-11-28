import assert from 'node:assert/strict'
import { refreshMarket } from '../src/lib/investment-market.ts'

const original = globalThis.fetch
const calls = []
try {
  globalThis.fetch = async (url) => {
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop())
    calls.push(symbol)
    if (symbol === '123456.KS') return new Response(null, { status: 404 })
    const currency = symbol === 'BAD' ? 'EUR' : symbol === 'AAPL' ? 'USD' : 'KRW'
    return Response.json({
      chart: {
        result: [
          {
            meta: {
              symbol,
              currency,
              regularMarketPrice: symbol === 'JPYKRW=X' ? 8.333 : 100,
              regularMarketTime: 1720000000,
            },
          },
        ],
      },
    })
  }
  const assets = [
    { symbol: 'AAPL', exchange: 'NASDAQ', currency: 'USD' },
    { symbol: '123456', exchange: 'KRX', currency: 'KRW' },
    { symbol: '', exchange: '', currency: 'JPY' },
    { symbol: 'BAD', exchange: 'NYSE', currency: 'USD' },
  ]
  const [a, b] = await Promise.all([refreshMarket(assets), refreshMarket(assets)])
  assert.deepEqual(a, b)
  assert.equal(calls.filter((s) => s === 'AAPL').length, 1)
  assert.ok(calls.includes('123456.KQ'))
  assert.deepEqual(a.missing, ['BAD'])
  assert.equal(a.quotes.find((q) => q.key === '|JPY').value, '8.333')
  assert.equal(a.quotes[0].value, '100')
  assert.equal(a.quotes[0].at, new Date(1720000000000).toISOString())
  await refreshMarket(assets)
  assert.equal(calls.length, 5)
  console.log(
    'Passed quote identity, timestamp, KOSDAQ fallback, FX units, partial failure and shared cache.',
  )
} finally {
  globalThis.fetch = original
}
