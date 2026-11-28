import { useEffect, useMemo, useState } from 'react'
import { dailyValues, dayOf, money, type Book, type Quote } from '@/lib/investment-book'
import { marketInstruments, type MarketInstrument } from '@/lib/market-instruments'

function historyRequest(book: Book, through: string) {
  const firstDay = Date.parse(through) - 180 * 86400000
  const before = book.events.filter((e) => !e.cancelled && Date.parse(dayOf(e.at)) < firstDay)
  const wanted = new Map<string, MarketInstrument>()
  function add(item: MarketInstrument) {
    wanted.set(item.symbol + '|' + item.currency, item)
  }
  for (const item of marketInstruments({ ...book, events: before })) add(item)
  for (const e of book.events) {
    const date = dayOf(e.at)
    if (e.cancelled || date > through || Date.parse(date) < firstDay) continue
    if (e.symbol) add({ symbol: e.symbol, currency: e.currency, exchange: e.exchange })
    for (const currency of [e.currency, e.kind === 'fx' ? e.target : '']) {
      if (currency && currency !== 'KRW') add({ symbol: '', currency, exchange: '' })
    }
  }
  return JSON.stringify([...wanted.values()])
}

export function ValuationTrend({ book, total }: { book: Book; total: bigint | null }) {
  const today = dayOf(new Date().toISOString())
  const [selected, setSelected] = useState('')
  const through = selected || today
  const request = useMemo(() => historyRequest(book, through), [book, through])
  const [retry, setRetry] = useState(0)
  const [history, setHistory] = useState<{ key: string; quotes: Quote[]; missing: string[] }>()
  const key = through + request
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const items: MarketInstrument[] = JSON.parse(request)
      const quotes: Quote[] = [],
        missing: string[] = []
      for (let i = 0; i < items.length; i += 16) {
        const batch = items.slice(i, i + 16)
        try {
          const response = await fetch('/api/investments/market', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruments: batch, through }),
            signal: controller.signal,
          })
          if (!response.ok) throw Error()
          const result = await response.json()
          quotes.push(...result.quotes)
          missing.push(...result.missing)
        } catch {
          if (controller.signal.aborted) return
          missing.push(...batch.map((item) => item.symbol || item.currency))
        }
      }
      if (!controller.signal.aborted) setHistory({ key, quotes, missing })
    }
    void load()
    return () => controller.abort()
  }, [request, through, key, retry])
  const ready = history?.key === key ? history : undefined
  const points = useMemo(
    () => dailyValues(book, through, ready?.quotes ?? [], through === today ? total : undefined),
    [book, through, ready, today, total],
  )
  const known = points.flatMap((p) => (p.value === null ? [] : [p.value]))
  const low = known.reduce((a, b) => (a < b ? a : b), known[0] ?? 0n)
  const high = known.reduce((a, b) => (a > b ? a : b), known[0] ?? 0n)
  const start = Date.parse(points[0]?.day ?? '1970-01-01')
  const duration = Date.parse(points.at(-1)?.day ?? '1970-01-01') - start
  let path = '',
    connected = false
  const dots = []
  for (const { day, value } of points) {
    if (value === null) {
      connected = false
      continue
    }
    const x = duration ? 2 + (996 * (Date.parse(day) - start)) / duration : 500
    const y = high === low ? 50 : 94 - (88 * Number(value - low)) / Number(high - low)
    path += (connected ? ' L ' : ' M ') + x + ' ' + y
    connected = true
    dots.push(
      <circle key={day} cx={x} cy={y} r="2" fill="currentColor">
        <title>
          {day} · {money(value)}
        </title>
      </circle>,
    )
  }
  return (
    <section className="iv-panel iv-trend" aria-label="총 투자·외화 평가액 추이">
      <h2>총 투자·외화 평가액 추이</h2>
      <label>
        조회 기준일{' '}
        <input
          type="date"
          max={today}
          value={through}
          onChange={(e) => {
            if (!e.target.value || e.target.value <= today) setSelected(e.target.value)
          }}
        />
      </label>
      {!ready && <p>과거 종가와 환율을 불러오는 중입니다.</p>}
      {!!ready?.missing.length && (
        <p>
          과거 시세 조회 실패 · {ready.missing.join(', ')}{' '}
          <button className="outline" onClick={() => setRetry((n) => n + 1)}>
            다시 조회
          </button>
        </p>
      )}
      {known.length ? (
        <>
          <div className="iv-trend-plot">
            <div>
              <span>{money(high)}</span>
              {high !== low && <span>{money(low)}</span>}
            </div>
            <svg
              viewBox="0 0 1000 100"
              preserveAspectRatio="none"
              role="img"
              aria-label="기록일별 원화 평가액 꺾은선그래프"
            >
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              {dots}
            </svg>
          </div>
          <div className="iv-trend-dates">
            <time>{points[0].day}</time>
            {points.length > 1 && <time>{points.at(-1)?.day}</time>}
          </div>
          <details>
            <summary>기록일별 평가액 보기</summary>
            <dl>
              {points.map((p) => (
                <div key={p.day}>
                  <dt>{p.day}</dt>
                  <dd>{money(p.value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      ) : (
        <p>거래와 시세·환율이 기록되면 평가액 추이가 표시됩니다.</p>
      )}
    </section>
  )
}
