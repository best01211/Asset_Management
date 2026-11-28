import assert from 'node:assert/strict'
import {
  dec,
  holdings,
  replay,
  sumKnown,
  periodPerformance,
  dailyValues,
} from '../src/lib/investment-book.ts'
import { emptyEntry } from '../src/lib/investment-demo.ts'

{
  const events = [
    { kind: 'deposit', gross: '130000', currency: 'KRW' },
    { kind: 'fx', currency: 'KRW', gross: '130000', target: 'USD', received: '100' },
    { kind: 'buy', currency: 'USD', symbol: 'X', gross: '100', qty: '10', rate: '1300' },
    { kind: 'sell', currency: 'USD', symbol: 'X', gross: '120', qty: '10', rate: '1300' },
  ].map((e, i) => ({
    ...emptyEntry,
    ...e,
    account: 'a',
    id: String(i),
    at: '2025-01-0' + (i + 1) + 'T03:00:00Z',
  }))
  const ledger = { accounts: [{ id: 'a', name: 'A' }], events, quotes: [] }
  const history = [
    { key: '|USD', value: '1300', at: '2025-01-02' },
    { key: 'X|USD', value: '11', at: '2025-01-03' },
    { key: '|USD', value: '1400', at: '2025-01-04' },
  ]
  assert.deepEqual(
    dailyValues(ledger, '2025-01-04', history, undefined).map((p) => p.value),
    ['0', '130000', '143000', '168000'].map(dec),
  )
  assert.equal(dailyValues(ledger, '2025-01-03', history.slice(2), undefined).at(-1).value, null)
  assert.equal(dailyValues(ledger, '2025-01-20', history, undefined).at(-1).value, null)
  assert.equal(dailyValues(ledger, '2025-01-20', history, dec('170000')).at(-1).value, dec('170000'))
}

const book = {
  accounts: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
  events: [],
  quotes: [
    { key: 'X|USD', value: '15', at: '2024-03-01', source: 'test' },
    { key: '|USD', value: '1400', at: '2024-03-01', source: 'test' },
  ],
}
function add(e) {
  book.events.push({
    ...emptyEntry,
    id: String(book.events.length),
    account: 'a',
    currency: 'USD',
    rate: '1200',
    at: '2024-01-01',
    ...e,
  })
}
add({ kind: 'deposit', gross: '100' })
add({ kind: 'buy', symbol: 'X', qty: '4', gross: '40', fee: '2' })
add({ kind: 'sell', symbol: 'X', qty: '2', gross: '30', tax: '1', rate: '1300' })
add({ kind: 'dividend', symbol: 'X', gross: '6', tax: '1', rate: '1300' })
const portfolio = () => {
  const p = replay(book)
  return { ...p, stocks: holdings(p.stocks, book.quotes), cash: holdings(p.cash, book.quotes) }
}
let p = portfolio()
const nextQuotes = book.quotes.map((q) => ({
  ...q,
  at: '2024-03-02',
  value: q.key === 'X|USD' ? '16.5' : q.value,
}))
assert.equal(periodPerformance(p.stocks, book.events, book.quotes, false), null)
assert.equal(
  periodPerformance(p.stocks, book.events, [...book.quotes, ...nextQuotes], false).percent,
  dec('10'),
)
assert.equal(p.realized, dec('12500'))
assert.equal(p.dividends, dec('6500'))
assert.equal(p.stocks[0].gain, dec('16800'))
const total = sumKnown([...p.cash, ...p.stocks].map((r) => r.value))
assert.equal(total, dec('170800'))
add({ kind: 'transfer', gross: '50', destination: 'b', rate: '' })
p = portfolio()
assert.equal(p.cash[0].accounts.length, 2)
assert.equal(sumKnown([...p.cash, ...p.stocks].map((r) => r.value)), total)
book.events[1].gross = '48'
assert.equal(portfolio().realized, dec('7700'))
book.events.at(-1).cancelled = true
assert.equal(portfolio().cash[0].accounts.length, 1)
add({ kind: 'deposit', currency: 'JPY', gross: '100', rate: '' })
assert.equal(portfolio().cash.find((r) => r.currency === 'JPY').gain, null)
add({ kind: 'sell', symbol: 'X', qty: '3', gross: '15' })
assert.throws(() => portfolio(), /보유 수량/)
book.events.pop()
const cashOnly = { ...book, events: [] }
cashOnly.events.push(
  { ...book.events[0], gross: '100' },
  { ...book.events[0], kind: 'fx', gross: '50', rate: '1400', target: 'KRW', received: '68000' },
)
assert.equal(replay(cashOnly).fxGain, dec('8000'))
console.log(
  'Investment replay passed: buys, sales, fees, dividends, FX, transfers, corrections, cancellation, unknown cost, and valuation.',
)
