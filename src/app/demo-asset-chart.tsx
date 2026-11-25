'use client'

import { useState } from 'react'
import { formatWon } from '@/lib/format-finance'
import { daysBetween, monthEnd, monthsBefore } from '@/lib/home-dates'
import { accountBalance } from '@/lib/local-finance'
import type { Finance, Purchase } from '@/lib/local-finance'

const ranges = [1, 3, 6, 12] as const
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 })
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
const width = 420
const height = 106
const won = (value: bigint) => formatWon(value.toString())
const signed = (value: bigint) => (value > 0n ? '+' : '') + won(value)

export type AssetPoint = { date: string; amount: string | null }

export function AssetChart({ date, points, basis, balanceStatus, unavailable, monthly = false }: {
  date: string; points: AssetPoint[]; basis: string; balanceStatus: string; unavailable?: string; monthly?: boolean
}) {
  const [months, setMonths] = useState<number>(1)
  const start = monthsBefore(date, months)
  const dateFormat = start.slice(0, 4) === date.slice(0, 4) ? shortDate : fullDate
  const dateLabel = (value: string) => dateFormat.format(new Date(value + 'T00:00:00Z'))
  const rangePoints = points.filter((point) => point.date >= start && point.date <= date)
  const valid = rangePoints.flatMap(({ date: day, amount }) => amount === null ? [] : [{ date: day, amount: Number(amount) }])
  const previous = points.find((point) => point.date === monthEnd(date, -1))?.amount
  const latest = points.find((point) => point.date === date)?.amount
  const difference = latest != null && previous != null ? BigInt(latest) - BigInt(previous) : null
  const rate = difference !== null && previous != null && BigInt(previous) !== 0n
    ? Number(difference) / Math.abs(Number(previous)) * 100 : null
  const values = valid.map(({ amount }) => amount)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max((max - min) * 0.1, 1)
  const top = max + padding
  const bottom = min - padding
  const coordinates = (day: string, amount: number) => [
    daysBetween(start, day) / Math.max(daysBetween(start, date), 1) * width,
    (top - amount) / (top - bottom) * (height - 12) + 6,
  ] as const
  const path = rangePoints.map((point, index) => {
    if (point.amount === null) return ''
    const [x, y] = coordinates(point.date, Number(point.amount))
    const command = rangePoints[index - 1]?.amount == null ? 'M' : 'L'
    return command + x.toFixed(2) + ',' + y.toFixed(2)
  }).join(' ')
  const changes = rangePoints.flatMap((point, index) => {
    const prior = rangePoints[index - 1]
    if (point.amount === null || point.amount === prior?.amount) return []
    return [{ ...point, amount: point.amount, change: prior?.amount == null ? null : BigInt(point.amount) - BigInt(prior.amount) }]
  })
  const missing = rangePoints.some((point) => point.amount === null) || (!monthly && rangePoints[0]?.date !== start)

  return <section className="panel demo-assets-chart" aria-labelledby="home-asset-heading">
    <div className="demo-card-heading">
      <h2 id="home-asset-heading">순자산 추이</h2>
      <label className="demo-asset-period">기간
        <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
          {ranges.map((range) => <option key={range} value={range}>{range === 12 ? '1년' : range + '개월'}</option>)}
        </select>
      </label>
    </div>
    <div className="demo-asset-total"><strong>{latest == null ? '조회 불가' : formatWon(latest)}</strong>
      <span>전월 말 대비 {difference === null ? '비교 데이터 없음' : <>{signed(difference)} · {rate === null ? '증감률 산정 불가' : `${rate > 0 ? '+' : ''}${rate.toFixed(1)}%`}</>}</span>
    </div>
    <p className="home-note">{basis} · <time dateTime={date}>{date}</time> 기준</p>
    {valid.length ? <div className="demo-asset-plot">
      <div className="demo-asset-scale" aria-hidden="true">
        {[top, (top + bottom) / 2, bottom].map((amount, index) => <span key={index}>{compact.format(amount)}원</span>)}
      </div>
      <svg role="img" aria-label={`순자산 추이 ${start}부터 ${date}까지`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[1, height / 2, height - 1].map((y) => <line key={y} x1="0" y1={y} x2={width} y2={y} className="demo-asset-grid" />)}
        <path className="demo-asset-line" d={path} />
        {valid.filter((point) => valid.length <= 13 || changes.some((change) => change.date === point.date) || point.date === date).map((point) => {
          const [x, y] = coordinates(point.date, point.amount)
          return <line key={point.date} className="home-asset-point" x1={x} x2={x} y1={y} y2={y + 0.01} />
        })}
      </svg>
      <div className="demo-asset-dates"><time dateTime={start}>{dateLabel(start)}</time><time dateTime={date}>{dateLabel(date)}</time></div>
    </div> : <p className="demo-empty">{unavailable ?? '조회 기간에 순자산 기록이 없습니다.'}</p>}
    {valid.length > 0 && latest == null && unavailable && <p className="home-note">{unavailable}</p>}
    <p className="home-note">{balanceStatus}{valid.length > 0 && missing && ' · 일부 기간 데이터 없음'}</p>
    {changes.length > 0 && <details className="home-details"><summary>변동 내역</summary>
      <ul className="home-asset-changes">{changes.map((point) => <li key={point.date}>
        <time dateTime={point.date}>{point.date}</time><strong>{formatWon(point.amount)}</strong>
        <span>{point.change === null ? '비교 기준 없음' : signed(point.change)}</span>
      </li>)}</ul>
    </details>}
  </section>
}

export default function DemoAssetChart({ data, approved, date }: { data: Finance; approved: Purchase[]; date: string }) {
  const baseline = data.accounts.reduce((start, item) => item.openedOn && item.openedOn > start ? item.openedOn : start, data.ledgerStartsOn ?? date)
  const earliest = monthsBefore(date, 12)
  const start = baseline > earliest ? baseline : earliest
  const days = daysBetween(start, date)
  const startMs = Date.parse(start + 'T00:00:00Z')
  const points: AssetPoint[] = []
  for (let index = 0; data.accounts.length && index <= days; index++) {
    const day = new Date(startMs + index * 86_400_000).toISOString().slice(0, 10)
    const posted = approved.filter((purchase) => purchase.date <= day)
    const balance = data.accounts.reduce((sum, account) =>
      sum + BigInt(accountBalance(account, posted)) * (account.kind === 'credit' ? -1n : 1n), 0n)
    points.push({ date: day, amount: balance.toString() })
  }
  return <AssetChart date={date} points={points} basis="샘플 원화 계좌 · 확정 거래 기준" balanceStatus="실제 잔액 확인 대상 아님" />
}
