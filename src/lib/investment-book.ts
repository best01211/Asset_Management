/** All accounting amounts use eight fixed decimal places. Only formatting rounds to currency precision. */
export const scale = 100000000n
export function dec(s: string) {
  if (!/^-?\d{1,30}(\.\d{1,8})?$/.test(s)) throw Error('금액과 수량은 소수 8자리까지 입력하세요.')
  const [a, b = ''] = s.replace('-', '').split('.')
  return (BigInt(a) * scale + BigInt(b.padEnd(8, '0'))) * (s.startsWith('-') ? -1n : 1n)
}
export function decimal(n: bigint) {
  const a = n < 0n ? -n : n
  return (
    (n < 0n ? '-' : '') +
    (a / scale).toString() +
    ('.' + (a % scale).toString().padStart(8, '0')).replace(/0+$/, '').replace(/\.$/, '')
  )
}
function rounded(n: bigint, d: bigint) {
  return (n + (n < 0n ? -1n : 1n) * (d / 2n)) / d
}
export const mul = (a: bigint, b: bigint) => rounded(a * b, scale)
export const div = (a: bigint, b: bigint) => rounded(a * scale, b)
export const kinds = {
  buy: '매수',
  sell: '매도',
  dividend: '배당',
  fx: '환전',
  deposit: '입금',
  withdraw: '출금',
  transfer: '계좌 이동',
} as const
export type Kind = keyof typeof kinds
export type Entry = {
  id: string
  version: number
  account: string
  at: string
  kind: Kind
  currency: string
  gross: string
  fee: string
  tax: string
  rate: string
  symbol: string
  qty: string
  name: string
  exchange: string
  category: string
  target: string
  received: string
  destination: string
  memo: string
  legacy?: boolean
  cancelled?: boolean
}
export type Quote = { key: string; value: string; at: string; source: string }
export type Book = { accounts: { id: string; name: string }[]; events: Entry[]; quotes: Quote[] }
export type Lot = {
  id: string
  account: string
  symbol: string
  currency: string
  name: string
  exchange: string
  category: string
  units: bigint
  cost: bigint | null
  local: bigint
}
export const keyOf = (symbol: string, currency: string) => symbol + '|' + currency
const basisPart = (cost: bigint, units: bigint, total: bigint) =>
  units === total ? cost : rounded(cost * units, total)
export function replay(book: Book) {
  const stocks = new Map<string, Lot>(),
    cash = new Map<string, Lot>()
  const bySecurity = new Map<string, { realized: bigint; dividends: bigint; fees: bigint; tax: bigint }>()
  let realized = 0n,
    fxGain: bigint | null = 0n,
    dividends = 0n,
    charges = 0n
  const lot = (map: Map<string, Lot>, account: string, symbol: string, currency: string, e: Entry) => {
    const id = account + '|' + keyOf(symbol, currency)
    let row = map.get(id)
    if (!row) {
      row = {
        id,
        account,
        symbol,
        currency,
        name: symbol ? e.name || symbol : currency,
        exchange: e.exchange,
        category: e.category,
        units: 0n,
        cost: 0n,
        local: 0n,
      }
      map.set(id, row)
    }
    return row
  }
  for (const e of book.events
    .filter((e) => !e.cancelled)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const g = dec(e.gross),
      f = dec(e.fee) + dec(e.tax),
      r = e.rate ? dec(e.rate) : 0n,
      q = e.qty ? dec(e.qty) : 0n
    if (
      g <= 0n ||
      dec(e.fee) < 0n ||
      dec(e.tax) < 0n ||
      r < 0n ||
      (['buy', 'sell'].includes(e.kind) && q <= 0n) ||
      (['sell', 'dividend'].includes(e.kind) && f > g)
    )
      throw Error('거래 금액, 수량, 비용을 확인하세요.')
    charges += mul(f, r)
    const securityKey = keyOf(e.symbol, e.currency)
    const performance = bySecurity.get(securityKey) ?? { realized: 0n, dividends: 0n, fees: 0n, tax: 0n }
    if (e.symbol) {
      performance.fees += mul(dec(e.fee), r)
      performance.tax += mul(dec(e.tax), r)
      bySecurity.set(securityKey, performance)
    }
    const wallet = lot(cash, e.account, '', e.currency, e)
    const add = (l: Lot, units: bigint, cost: bigint | null) => {
      l.cost = l.units < 0n || l.cost === null || cost === null ? null : l.cost + cost
      l.units += units
      if (!l.units) l.cost = 0n
    }
    const take = (amount: bigint) => {
      if (wallet.units < amount && !e.legacy) throw Error('해당 시점의 계좌 잔액이 부족합니다.')
      const cost =
        wallet.units < amount || wallet.cost === null ? null : basisPart(wallet.cost, amount, wallet.units)
      add(wallet, -amount, cost === null ? null : -cost)
      return cost
    }
    const disposal = (amount: bigint) => {
      const cost = take(amount)
      if (e.currency !== 'KRW')
        fxGain = fxGain === null || cost === null ? null : fxGain + mul(amount, r) - cost
    }
    if (e.kind === 'deposit') add(wallet, g, e.currency === 'KRW' ? g : r ? mul(g, r) : null)
    else if (e.kind === 'withdraw') take(g)
    else if (e.kind === 'transfer') {
      if (e.destination === e.account || !book.accounts.some((a) => a.id === e.destination))
        throw Error('서로 다른 두 계좌를 선택하세요.')
      add(lot(cash, e.destination, '', e.currency, e), g, take(g))
    } else if (e.kind === 'fx') {
      if (e.target === e.currency || dec(e.received) <= 0n) throw Error('환전 통화와 수량을 확인하세요.')
      if (e.target === 'KRW') {
        const cost = take(g + f)
        fxGain = fxGain === null || cost === null ? null : fxGain + dec(e.received) - cost
      } else disposal(g + f)
      add(lot(cash, e.account, '', e.target, e), dec(e.received), mul(g + f, r))
    } else if (e.kind === 'dividend') {
      dividends += mul(g - f, r)
      performance.dividends += mul(g - f, r)
      add(wallet, g - f, mul(g - f, r))
    } else {
      const stock = lot(stocks, e.account, e.symbol, e.currency, e)
      if (e.kind === 'buy') {
        disposal(g + f)
        add(stock, q, mul(g + f, r))
        stock.local += g + f
      } else {
        if (q > stock.units) throw Error('해당 시점의 보유 수량을 초과해 매도할 수 없습니다.')
        const cost = basisPart(stock.cost!, q, stock.units)
        stock.local -= basisPart(stock.local, q, stock.units)
        add(stock, -q, -cost)
        realized += mul(g - f, r) - cost
        performance.realized += mul(g - f, r) - cost
        add(wallet, g - f, mul(g - f, r))
      }
    }
  }
  return {
    stocks: [...stocks.values()].filter((x) => x.units > 0n),
    cash: [...cash.values()].filter((x) => x.units !== 0n && x.currency !== 'KRW'),
    realized,
    fxGain,
    dividends,
    charges,
    bySecurity,
  }
}
export function holdings(lots: Lot[], quotes: Quote[]) {
  const latest = new Map(
    [...quotes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((q) => [q.key, q]),
  )
  const groups = new Map<string, Lot[]>()
  for (const l of lots) {
    const key = keyOf(l.symbol, l.currency)
    groups.set(key, [...(groups.get(key) || []), l])
  }
  return [...groups.entries()].map(([key, accounts]) => {
    const first = accounts[0],
      qty = accounts.reduce((s, l) => s + l.units, 0n)
    const cost = accounts.some((l) => l.cost === null || l.units < 0n)
      ? null
      : accounts.reduce((s, l) => s + l.cost!, 0n)
    const priceQuote = latest.get(key),
      rateQuote = latest.get(keyOf('', first.currency))
    const rate = first.currency === 'KRW' ? scale : rateQuote ? dec(rateQuote.value) : null
    const price = first.symbol ? (priceQuote ? dec(priceQuote.value) : null) : scale
    const local = accounts.reduce((s, l) => s + l.local, 0n)
    const value =
      rate !== null && price !== null && accounts.every((l) => l.units >= 0n)
        ? mul(mul(qty, price), rate)
        : null
    const gain = value !== null && cost !== null ? value - cost : null
    return {
      ...first,
      id: key,
      accounts,
      qty,
      cost,
      rate,
      price,
      priceQuote,
      rateQuote,
      value,
      gain,
      local,
      average: qty > 0n ? (first.symbol ? div(local, qty) : cost === null ? null : div(cost, qty)) : null,
      percent: gain !== null && cost !== null && cost > 0n ? div(gain * 100n, cost) : null,
    }
  })
}
export type Holding = ReturnType<typeof holdings>[number]
/** Measure a cash-flow-free holding interval at two fully observed valuation times. */
export function periodPerformance(rows: Holding[], events: Entry[], quotes: Quote[], fx: boolean) {
  if (!rows.length || rows.some((row) => row.qty <= 0n || row.cost === null)) return null
  const active = events.filter((e) => !e.cancelled)
  const lastMovement = active.reduce(
    (last, e) => (fx || e.kind === 'buy' || e.kind === 'sell' ? Math.max(last, Date.parse(e.at)) : last),
    0,
  )
  const snapshots = new Map<number, Map<string, bigint>>()
  for (const q of quotes) {
    const at = Date.parse(q.at)
    if (at < lastMovement) continue
    const prices = snapshots.get(at) ?? new Map<string, bigint>()
    prices.set(q.key, dec(q.value))
    snapshots.set(at, prices)
  }
  const observations: { at: number; value: bigint }[] = []
  for (const [at, prices] of snapshots) {
    const values = rows.map((row) => {
      const price = row.symbol ? prices.get(row.id) : scale
      const rate = row.currency === 'KRW' ? scale : prices.get(keyOf('', row.currency))
      return price && rate ? mul(mul(row.qty, price), rate) : null
    })
    const value = sumKnown(values)
    if (value !== null && value > 0n) observations.push({ at, value })
  }
  observations.sort((a, b) => a.at - b.at)
  if (observations.length < 2) return null
  const start = observations[0],
    end = observations[observations.length - 1]
  const income = fx
    ? 0n
    : active
        .filter(
          (e) =>
            e.kind === 'dividend' &&
            Date.parse(e.at) > start.at &&
            Date.parse(e.at) <= end.at &&
            rows.some((row) => row.id === keyOf(e.symbol, e.currency)),
        )
        .reduce((s, e) => s + mul(dec(e.gross) - dec(e.fee) - dec(e.tax), dec(e.rate)), 0n)
  return {
    start: start.at,
    end: end.at,
    percent: div((end.value - start.value + income) * 100n, start.value),
  }
}
export function sumKnown(values: (bigint | null)[]) {
  return values.reduce<bigint | null>((s, v) => (s === null || v === null ? null : s + v), 0n)
}
export function money(v: bigint | null, unit = 'KRW') {
  if (v === null) return '산정 보류'
  const digits =
    new Intl.NumberFormat('ko-KR', { style: 'currency', currency: unit }).resolvedOptions()
      .maximumFractionDigits ?? 0
  const factor = 10n ** BigInt(digits),
    n = rounded(v * factor, scale),
    abs = n < 0n ? -n : n
  return (
    (n < 0n ? '−' : '') +
    (abs / factor).toLocaleString('ko-KR') +
    (digits ? '.' + (abs % factor).toString().padStart(digits, '0') : '') +
    (unit === 'KRW' ? '원' : ' ' + unit)
  )
}

// Each point uses the final recorded balances and latest known quotes for that Korean calendar day.
export const dayOf = (at: string) => new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10)
export function dailyValues(
  book: Book,
  through: string,
  history: Quote[],
  current: bigint | null | undefined,
) {
  const events = book.events.filter((e) => !e.cancelled).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (!events.length) return []
  const quotes = [...history, ...book.quotes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const days = [...new Set([...events, ...quotes].map((item) => dayOf(item.at)).concat(through))]
    .filter(
      (day) =>
        day >= dayOf(events[0].at) &&
        day <= through &&
        Date.parse(through) - Date.parse(day) < 180 * 86400000,
    )
    .sort()
    .slice(-90)
  let eventIndex = 0,
    quoteIndex = 0
  let balances = replay({ ...book, events: [] })
  const latest = new Map<string, Quote>()
  return days.map((day) => {
    const previous = eventIndex
    while (eventIndex < events.length && dayOf(events[eventIndex].at) <= day) eventIndex++
    if (eventIndex !== previous) balances = replay({ ...book, events: events.slice(0, eventIndex) })
    while (quoteIndex < quotes.length && dayOf(quotes[quoteIndex].at) <= day) {
      const quote = quotes[quoteIndex++]
      latest.set(quote.key, quote)
    }
    if (day === through && current !== undefined) return { day, value: current }
    const values = holdings(
      [...balances.stocks, ...balances.cash],
      [...latest.values()].filter((q) => Date.parse(day) - Date.parse(dayOf(q.at)) <= 7 * 86400000),
    )
    return { day, value: sumKnown(values.map((row) => row.value)) }
  })
}
