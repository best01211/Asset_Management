import { keyOf, replay, type Book } from './investment-book'

export type MarketInstrument = { symbol: string; currency: string; exchange: string }
export function marketInstruments(book: Book): MarketInstrument[] {
  const portfolio = replay(book)
  const wanted = new Map<string, MarketInstrument>()
  for (const lot of [...portfolio.stocks, ...portfolio.cash]) {
    if (lot.symbol)
      wanted.set(keyOf(lot.symbol, lot.currency), {
        symbol: lot.symbol,
        currency: lot.currency,
        exchange: lot.exchange,
      })
    if (lot.currency !== 'KRW')
      wanted.set(keyOf('', lot.currency), { symbol: '', currency: lot.currency, exchange: '' })
  }
  return [...wanted.values()]
}
