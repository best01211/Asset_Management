import type { Book, Entry } from './investment-book'
export const emptyEntry: Omit<Entry, 'id' | 'at' | 'account'> = {
  version: 0,
  kind: 'buy',
  currency: 'KRW',
  gross: '0',
  rate: '1',
  fee: '0',
  tax: '0',
  symbol: '',
  qty: '',
  name: '',
  exchange: '',
  category: 'unknown',
  target: '',
  received: '',
  destination: '',
  memo: '',
}
export function sampleBook(): Book {
  const accounts = [
    { id: 'broker', name: '미래에셋증권' },
    { id: 'toss', name: '토스증권' },
    { id: 'wallet', name: '외화 계좌' },
  ]
  const events: Entry[] = []
  function add(at: string, data: Partial<Entry>) {
    events.push({
      ...emptyEntry,
      id: 'sample-' + events.length,
      at: at + 'T03:00:00Z',
      account: 'broker',
      ...data,
    })
  }
  add('2025-01-02', { kind: 'deposit', gross: '15000000' })
  add('2025-01-03', { kind: 'fx', gross: '7000000', target: 'USD', received: '5000' })
  add('2025-01-04', {
    symbol: '005930',
    name: '삼성전자',
    exchange: 'KRX',
    category: 'domestic',
    gross: '4200000',
    qty: '70',
  })
  add('2025-01-05', {
    kind: 'transfer',
    currency: 'USD',
    gross: '2000',
    rate: '',
    destination: 'toss',
  })
  add('2025-01-05', {
    account: 'toss',
    symbol: 'AAPL',
    name: '애플',
    exchange: 'NASDAQ',
    category: 'overseas',
    gross: '2000',
    qty: '10',
    currency: 'USD',
    rate: '1400',
  })
  add('2025-01-06', {
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF',
    exchange: 'NYSE Arca',
    category: 'etf',
    gross: '1200',
    qty: '2',
    currency: 'USD',
    rate: '1400',
  })
  add('2025-01-07', { kind: 'deposit', currency: 'JPY', account: 'wallet', gross: '80000', rate: '9.1' })
  return {
    accounts,
    events,
    quotes: [
      ['005930|KRW', '67200'],
      ['AAPL|USD', '219.30'],
      ['SPY|USD', '594.20'],
      ['|USD', '1420'],
      ['|JPY', '9.28'],
    ].map(([key, value]) => ({ key, value, at: '2025-01-08T06:30:00Z', source: '샘플 시세' })),
  }
}
