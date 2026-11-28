import { dec, replay, type Book, type Entry, type Quote } from '@/lib/investment-book'
import { sampleBook } from '@/lib/investment-demo'
import { marketInstruments } from '@/lib/market-instruments'
export const demoKey = 'asset-management:investments:v1'
export type Change =
  | { action: 'event'; entry: Entry; create: boolean; request: string }
  | { action: 'quote'; quote: Quote }
  | { action: 'account'; name: string }
export function demoBook(): Book {
  const raw = localStorage.getItem(demoKey)
  return raw ? JSON.parse(raw) : sampleBook()
}
async function api(options?: RequestInit, asset = '') {
  const path = '/api/investments/workspace' + (asset ? '?' + new URLSearchParams({ asset }) : '')
  const r = await fetch(path, { cache: 'no-store', ...options }),
    v = await r.json()
  if (!r.ok) {
    const errors: Record<string, string> = {
      UNAUTHORIZED: '연결된 사용자 세션이 필요합니다.',
      INVESTMENT_INSUFFICIENT_HOLDINGS: '해당 시점의 보유 수량이 부족합니다.',
      INVESTMENT_INSUFFICIENT_CASH: '거래 시점의 계좌 잔액이 부족합니다.',
      INVESTMENT_VERSION_CONFLICT: '다른 화면에서 거래를 변경했습니다. 화면을 다시 열어 확인하세요.',
    }
    throw Error(errors[v.error] || '투자 데이터를 읽거나 저장할 수 없습니다. ' + (v.error || r.status))
  }
  return v
}
export const readBook = async (demo: boolean, asset = ''): Promise<Book> =>
  demo ? demoBook() : api(undefined, asset)
export const post = (body: unknown) =>
  api({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export function mergePrices(current: Quote[], incoming: Quote[]) {
  const merged = new Map(current.map((q) => [q.key + '@' + Date.parse(q.at), q]))
  for (const q of incoming) merged.set(q.key + '@' + Date.parse(q.at), q)
  return [...merged.values()]
}
export async function refreshPrices(demo: boolean): Promise<{ message: string; quotes: Quote[] }> {
  if (!demo) return post({ action: 'refresh' })
  const instruments = marketInstruments(demoBook())
  const all: Quote[] = [],
    failures: string[] = []
  for (let i = 0; i < instruments.length; i += 64) {
    const res = await fetch('/api/investments/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruments: instruments.slice(i, i + 64) }),
    })
    if (!res.ok) throw Error('외부 시세 조회 실패')
    const batch = await res.json()
    all.push(...batch.quotes)
    failures.push(...batch.missing)
  }
  if (all.length)
    await navigator.locks.request(demoKey, () => {
      const latest = demoBook()
      const quotes = mergePrices(latest.quotes, all)
      if (JSON.stringify(quotes) !== JSON.stringify(latest.quotes))
        localStorage.setItem(demoKey, JSON.stringify({ ...latest, quotes }))
    })
  return {
    quotes: all,
    message: !instruments.length
      ? '갱신할 보유 자산이 없습니다.'
      : '외부 시세 ' +
        all.length +
        '건 확인' +
        (failures.length ? ' · 조회 실패 ' + failures.join(', ') + ' (마지막 값 유지)' : ' · Yahoo Finance'),
  }
}
export async function saveChange(demo: boolean, change: Change, asset = ''): Promise<Book> {
  if (!demo) {
    await post(change)
    return readBook(false, asset)
  }
  return navigator.locks.request(demoKey, () => {
    const book = demoBook()
    if (change.action === 'event') {
      const entry = change.entry,
        index = book.events.findIndex((e) => e.id === entry.id)
      if (change.create ? index !== -1 : index < 0 || book.events[index].version !== entry.version)
        throw Error('거래가 변경되었습니다. 다시 확인하세요.')
      const next = { ...entry, version: entry.version + 1 }
      if (index < 0) book.events.push(next)
      else book.events[index] = next
      replay(book)
    } else if (change.action === 'account') {
      if (!change.name.trim() || change.name.length > 120) throw Error('계좌 이름을 확인하세요.')
      if (!book.accounts.some((a) => a.name === change.name))
        book.accounts.push({ id: crypto.randomUUID(), name: change.name })
    } else {
      const q = change.quote
      if (dec(q.value) <= 0n || !q.source.trim() || Date.parse(q.at) > Date.now())
        throw Error('시세와 기준 시각, 출처를 확인하세요.')
      book.quotes = book.quotes.filter((v) => v.key !== q.key || v.at !== q.at).concat(q)
    }
    localStorage.setItem(demoKey, JSON.stringify(book))
    return book
  })
}
