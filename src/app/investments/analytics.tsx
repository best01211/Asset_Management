import { useMemo, useState } from 'react'
import {
  dec,
  decimal,
  div,
  money,
  mul,
  sumKnown,
  type Book,
  type Holding,
  type Entry,
  kinds,
  periodPerformance,
  type Quote,
} from '@/lib/investment-book'
export const classifications: Record<string, string> = {
  domestic: '국내',
  overseas: '해외',
  etf: 'ETF',
  unknown: '미분류',
}
export const pct = (v: bigint | null) =>
  v === null ? '산정 보류' : Number(decimal(v)).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '%'
export function Metrics({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="iv-metrics">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
const weightPercent = (value: bigint, total: bigint) => Number(div(value * 100n, total)) / 1e8
function AllocationChart({
  weights,
  total,
  rows,
  fx,
}: {
  weights: Map<string, bigint>
  total: bigint
  rows: Holding[]
  fx: boolean
}) {
  const colors = ['#7544b5', '#387586', '#d69c50', '#a086b7', '#548766', '#be7182']
  let cumulative = 0n
  const ordered = [...weights].sort((a, b) =>
    a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1,
  )
  const slices = []
  for (const [i, [name, value]] of ordered.entries()) {
    const start = weightPercent(cumulative, total)
    cumulative += value
    slices.push({
      name,
      value,
      color: colors[i] ?? `hsl(${(i * 137.508) % 360} 43% 48%)`,
      start,
      end: weightPercent(cumulative, total),
    })
  }
  const fill = slices.map((s) => s.color + ' ' + s.start + '% ' + s.end + '%').join(', ')
  return (
    <div className="iv-allocation">
      <div className="iv-donut" aria-hidden="true" style={{ background: 'conic-gradient(' + fill + ')' }}>
        <div>
          <small>평가액 합계</small>
          <b>{money(total)}</b>
        </div>
      </div>
      <ul aria-label="자산 구성 비중">
        {slices.map((s) => (
          <li key={s.name}>
            <i aria-hidden="true" style={{ background: s.color }} />
            <span>
              {s.name}
              {fx && (
                <small>환차손익 {money(rows.find((row) => row.currency === s.name)?.gain ?? null)}</small>
              )}
            </span>
            <strong>{pct(div(s.value * 100n, total))}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}
export function Analysis({
  rows,
  fx,
  realized,
  dividends,
  fees,
  events,
  quotes,
}: {
  rows: Holding[]
  fx: boolean
  realized: bigint | null
  dividends: bigint
  fees: bigint
  events: Entry[]
  quotes: Quote[]
}) {
  const [group, setGroup] = useState('asset')
  const period = useMemo(() => periodPerformance(rows, events, quotes, fx), [rows, events, quotes, fx])
  const total = sumKnown(rows.map((r) => r.value)),
    gain = sumKnown(rows.map((r) => r.gain)),
    basis = sumKnown(rows.map((r) => r.cost))
  const weights = new Map<string, bigint>()
  for (const r of rows) {
    const key =
      fx || group === 'currency'
        ? r.currency
        : group === 'category'
          ? classifications[r.category] || '미분류'
          : group === 'market'
            ? r.exchange === 'KRX' || r.category === 'domestic'
              ? '국내'
              : r.exchange || r.category === 'overseas'
                ? '해외'
                : '미분류'
            : r.name
    if (r.value !== null) weights.set(key, (weights.get(key) || 0n) + r.value)
  }
  return (
    <div className="iv-grid">
      <section className="iv-panel">
        <h2>{fx ? '통화별 자산 비중' : '포트폴리오 구성'}</h2>
        {!fx && (
          <label>
            비중 기준{' '}
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="asset">종목별</option>
              <option value="market">국내·해외</option>
              <option value="category">ETF·종목 구분</option>
              <option value="currency">통화별 노출</option>
            </select>
          </label>
        )}
        {total !== null && total > 0n ? (
          <AllocationChart weights={weights} total={total} rows={rows} fx={fx} />
        ) : (
          <p>비중을 계산할 평가액이 없습니다.</p>
        )}
      </section>
      <section className="iv-panel">
        <h2>{fx ? '환차손익' : '투자 성과'}</h2>
        <Metrics
          rows={[
            ['평가액', money(total)],
            ['취득 원가', money(basis)],
            ['미실현 손익', money(gain)],
            ['원가 대비 수익률', pct(gain !== null && basis && basis > 0n ? div(gain * 100n, basis) : null)],
            ['실현 손익', money(realized)],
            ['보유 기간 수익률', period ? pct(period.percent) : '비교 시세 부족'],
            ...(period
              ? ([
                  [
                    '보유 구성 유지 기간',
                    new Date(period.start).toLocaleDateString('ko-KR') +
                      ' ~ ' +
                      new Date(period.end).toLocaleDateString('ko-KR'),
                  ],
                ] as [string, string][])
              : []),
            ...((fx
              ? [['환전 횟수', events.filter((e) => !e.cancelled && e.kind === 'fx').length + '건']]
              : [
                  ['순배당금', money(dividends)],
                  ['전체 거래 비용·세금', money(fees)],
                ]) as [string, string][]),
          ]}
        />
      </section>
    </div>
  )
}
export function History({
  book,
  events,
  onEdit,
  onCancel,
}: {
  book: Book
  events: Entry[]
  onEdit: (e: Entry) => void
  onCancel: (e: Entry) => void
}) {
  const [query, setQuery] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const visible = events
    .filter((e) => {
      const date = e.at.slice(0, 10)
      return (
        (!from || date >= from) &&
        (!to || date <= to) &&
        [e.symbol, e.name, e.currency, e.target, e.memo, kinds[e.kind]]
          .join(' ')
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return (
    <section className="iv-panel">
      <div className="iv-tools">
        <input
          aria-label="거래 검색"
          placeholder="종목 · 통화 · 거래 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input aria-label="시작일" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input
          aria-label="종료일"
          type="date"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <div className="iv-scroll">
        <table>
          <thead>
            <tr>
              {['거래일', '거래', '계좌', '금액', '수수료', '세금', '관리'].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.at).toLocaleDateString('ko-KR')}</td>
                <td>
                  <strong>{e.name || e.symbol || e.currency}</strong>
                  <small>
                    {kinds[e.kind]} {e.qty && e.qty + '주'}{' '}
                    {e.kind === 'fx' && '→ ' + e.received + ' ' + e.target}
                  </small>
                </td>
                <td>
                  {book.accounts.find((a) => a.id === e.account)?.name}
                  {e.kind === 'transfer' && ' → ' + book.accounts.find((a) => a.id === e.destination)?.name}
                </td>
                <td>{money(dec(e.gross), e.currency)}</td>
                <td>{money(dec(e.fee), e.currency)}</td>
                <td>{money(dec(e.tax), e.currency)}</td>
                <td>
                  {e.cancelled ? (
                    '취소됨'
                  ) : (
                    <>
                      <button className="outline" onClick={() => onEdit(e)}>
                        정정
                      </button>{' '}
                      <button className="outline" onClick={() => onCancel(e)}>
                        취소
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <p>조회된 거래가 없습니다.</p>}
      </div>
    </section>
  )
}
export function PriceHistory({ book, row }: { book: Book; row: Holding }) {
  const [days, setDays] = useState('all'),
    [asOf] = useState(() => Date.now())
  const series = book.quotes
    .filter((q) => q.key === row.id && (days === 'all' || Date.parse(q.at) >= asOf - Number(days) * 86400000))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const values = series.map((q) => Number(q.value)),
    min = Math.min(...values),
    max = Math.max(...values)
  const start = Date.parse(series[0]?.at || ''),
    end = Date.parse(series.at(-1)?.at || '')
  return (
    <section className="iv-panel">
      <h2>
        종목 가격{' '}
        <select aria-label="시세 기간" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">1개월</option>
          <option value="90">3개월</option>
          <option value="all">전체 기간</option>
        </select>
      </h2>
      {series.length > 1 ? (
        <>
          <svg viewBox="0 0 520 110" role="img" aria-label={row.name + '의 저장된 시세 추이'}>
            <polyline
              fill="none"
              stroke="var(--brand-primary)"
              strokeWidth="3"
              points={series
                .map(
                  (q, i) =>
                    6 +
                    (508 * (Date.parse(q.at) - start)) / (end - start || 1) +
                    ',' +
                    (100 - (90 * (values[i] - min)) / (max - min || 1)),
                )
                .join(' ')}
            />
          </svg>
          <small>
            {series[0].at.slice(0, 10)} — {series.at(-1)?.at.slice(0, 10)} · {row.currency}
          </small>
        </>
      ) : (
        <p>이 기간에 저장된 시세 {series.length}건 · 차트에는 두 시점 이상이 필요합니다.</p>
      )}
    </section>
  )
}
export function insightLines(rows: Holding[], fx: boolean) {
  if (!rows.length) return ['등록된 보유 자산이 없습니다.']
  const known = sumKnown(rows.map((r) => r.value)),
    leader = rows.reduce((a, b) => ((a.value ?? 0n) >= (b.value ?? 0n) ? a : b))
  const gain = sumKnown(rows.map((r) => r.gain))
  return [
    known !== null && known > 0n
      ? leader.name + ' 비중이 ' + pct(div((leader.value ?? 0n) * 100n, known)) + '로 가장 큽니다.'
      : '시세 또는 잔액 자료가 부족해 보유 비중을 산정할 수 없습니다.',
    gain === null
      ? '취득 원가와 기준 시세가 모두 있는 자산에서 손익을 확인할 수 있습니다.'
      : (fx ? '보유 외화의 미실현 환차손익은 ' : '보유 종목의 미실현 평가손익은 ') + money(gain) + '입니다.',
  ]
}
export function fxEffect(row: Holding) {
  return row.rate !== null && row.cost !== null ? mul(row.local, row.rate) - row.cost : null
}
