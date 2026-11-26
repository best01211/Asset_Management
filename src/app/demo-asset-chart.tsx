'use client'

import { useId, useState } from 'react'
import type { PointerEvent } from 'react'
import { daysBetween, monthEnd, monthsBefore } from '@/lib/home-dates'
import { accountBalance } from '@/lib/local-finance'
import type { Finance, Purchase } from '@/lib/local-finance'
import { homeWon } from './editorial-home'

const ranges = [1, 3, 12] as const
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 })
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
const width = 600
const height = 240
const signed = (value: bigint) => (value > 0n ? '+' : '') + homeWon(value)

export type AssetPoint = { date: string; amount: string | null; source?: string }
type Totals = { assets: bigint; liabilities: bigint }
type AssetAccount = { id: string; name: string; kind: 'asset' | 'liability'; balance_minor: string | null }

export function AssetChart({ date, points, basis, balanceStatus, unavailable, monthly = false, totals, accounts, accountHref }: {
  date: string; points: AssetPoint[]; basis: string; balanceStatus?: string; unavailable?: string; monthly?: boolean
  totals: Totals | null; accounts?: AssetAccount[] | null; accountHref: string
}) {
  const gradient = useId()
  const instructions = useId()
  const [months, setMonths] = useState<number>(1)
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const start = monthsBefore(date, months)
  const dateLabel = (value: string) => (value.slice(0, 4) === date.slice(0, 4) ? shortDate : fullDate).format(new Date(value + 'T00:00:00Z'))
  const rangePoints = points.filter((point) => point.date >= start && point.date <= date)
  const valid = rangePoints.flatMap((point) => point.amount === null ? [] : [{ ...point, amount: point.amount }])
  const previous = points.find((point) => point.date === monthEnd(date, -1))?.amount
  const latest = points.find((point) => point.date === date)?.amount
  const difference = latest != null && previous != null ? BigInt(latest) - BigInt(previous) : null
  const rate = difference !== null && previous != null && BigInt(previous) !== 0n
    ? Number(difference) / Math.abs(Number(previous)) * 100 : null
  const values = valid.map(({ amount }) => Number(amount))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max((max - min) * 0.12, Math.max(Math.abs(min), Math.abs(max)) * 0.01, 1)
  const top = max + padding
  const bottom = min - padding
  const coordinates = (day: string, amount: string) => [
    daysBetween(start, day) / Math.max(daysBetween(start, date), 1) * width,
    (top - Number(amount)) / (top - bottom) * height,
  ] as const
  const segments: [number, number][][] = []
  let segment: [number, number][] = []
  for (const point of rangePoints) {
    if (point.amount === null) {
      segment = []
      continue
    }
    if (!segment.length) segments.push(segment)
    const [x, y] = coordinates(point.date, point.amount)
    segment.push([x, y])
  }
  const drawable = segments.filter((item) => item.length > 1)
  const missing = rangePoints.some((point) => point.amount === null) || (!monthly && rangePoints[0]?.date !== start)
  const active = valid.find((point) => point.date === (hovered ?? selected))
  const activePosition = active && coordinates(active.date, active.amount)
  const activeIndex = active ? valid.indexOf(active) : -1
  const nearestDate = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const offset = (event.clientX - bounds.left) / bounds.width * daysBetween(start, date)
    return valid.reduce((best, point) =>
      Math.abs(daysBetween(start, point.date) - offset) < Math.abs(daysBetween(start, best.date) - offset) ? point : best
    ).date
  }

  return <section className="home-assets" aria-labelledby="home-asset-heading">
    <div className="home-section-heading">
      <h2 id="home-asset-heading">순자산 추이</h2>
      <div className="home-asset-period" role="group" aria-label="순자산 추이 기간">
        {ranges.map((range) => <button type="button" key={range} aria-pressed={months === range} onClick={() => {
          setMonths(range)
          setHovered(null)
          setSelected(null)
        }}>{range === 12 ? '1년' : range + '개월'}</button>)}
      </div>
    </div>
    <div className="home-asset-total"><strong>{latest == null ? '산정 불가' : homeWon(latest)}</strong>
      {difference !== null && <span data-change={difference > 0n ? 'positive' : difference < 0n ? 'negative' : undefined}>
        {signed(difference)}{rate !== null && ' · ' + (rate > 0 ? '+' : '') + rate.toFixed(1) + '%'} <small>전월 말 대비</small>
      </span>}
    </div>
    <p className="home-note">{basis} · <time dateTime={date}>{date}</time> 기준</p>
    <details className="home-details home-asset-basis"><summary>순자산 계산 근거</summary>
      <p>총자산에서 총부채를 뺀 금액입니다.</p>
      {totals && <dl className="home-asset-totals">
        <div><dt>총자산</dt><dd>{homeWon(totals.assets)}</dd></div>
        <div><dt>총부채</dt><dd>{homeWon(totals.liabilities)}</dd></div>
      </dl>}
      {accounts?.length ? <ul className="home-account-list">{accounts.map((account) => <li key={account.id}>
        <span>{account.name} <small>{account.kind === 'asset' ? '자산' : '부채'}</small></span>
        <strong>{account.balance_minor === null ? '초기 잔액 필요' : homeWon(account.balance_minor)}</strong>
      </li>)}</ul> : null}
      {!totals && <p>{unavailable ?? '계좌 잔액을 확인해 주세요.'}</p>}
      <a className="home-text-link" href={accountHref}>계좌 잔액 확인 <span aria-hidden="true">→</span></a>
    </details>
    {drawable.length ? <div className="home-asset-plot">
      <div className="home-asset-scale" aria-hidden="true">
        {[top, (top + bottom) / 2, bottom].map((amount, index) => <span key={index}>{compact.format(amount)}원</span>)}
      </div>
      <div className="home-asset-pointer" tabIndex={0} role="group" aria-label="순자산 차트" aria-describedby={instructions}
        onPointerMove={(event) => {
          if (event.pointerType !== 'touch') setHovered(nearestDate(event))
        }}
        onPointerLeave={() => setHovered(null)}
        onPointerDown={(event) => setSelected(nearestDate(event))}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setSelected(null)
            setHovered(null)
          }
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          event.preventDefault()
          setHovered(null)
          const index = activeIndex < 0 ? (event.key === 'ArrowLeft' ? valid.length - 1 : 0)
            : Math.max(0, Math.min(valid.length - 1, activeIndex + (event.key === 'ArrowLeft' ? -1 : 1)))
          setSelected(valid[index].date)
        }}>
        <span id={instructions} className="home-visually-hidden">좌우 방향키로 날짜별 금액과 자료 출처를 확인할 수 있습니다.</span>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id={gradient} x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--brand-primary)" stopOpacity=".12" />
            <stop offset="100%" stopColor="var(--brand-primary)" stopOpacity="0" />
          </linearGradient></defs>
          {[1, height / 2, height - 1].map((y) => <line key={y} x1="0" y1={y} x2={width} y2={y} className="home-asset-gridline" />)}
          {drawable.map((item) => {
            const line = 'M' + item.map(([x, y]) => x + ',' + y).join('L')
            return <g key={item[0][0]}>
              <path fill={'url(#' + gradient + ')'} d={line + 'L' + item.at(-1)?.[0] + ',' + height + 'L' + item[0][0] + ',' + height + 'Z'} />
              <path className="home-asset-line" d={line} />
            </g>
          })}
        </svg>
        {active && activePosition && <div className="home-asset-marker" style={{ left: activePosition[0] / width * 100 + '%', top: activePosition[1] / height * 100 + '%' }} />}
        {active && activePosition && <div className="home-asset-tooltip" data-align={activePosition[0] > width / 2 ? 'right' : 'left'}>
          <time dateTime={active.date}>{dateLabel(active.date)}</time>
          <strong>{homeWon(active.amount)}</strong>
          {active.source && <span>{active.source}</span>}
        </div>}
        <span className="home-visually-hidden" aria-live="polite">{selected && active && !hovered ? active.date + ' ' + homeWon(active.amount) + ' ' + (active.source ?? '') : ''}</span>
      </div>
      <div className="home-asset-dates"><time dateTime={start}>{dateLabel(start)}</time><time dateTime={date}>{dateLabel(date)}</time></div>
    </div> : <div className="home-asset-empty">
      <p>{valid.length ? '추이를 표시하려면 이어지는 순자산 기록이 필요합니다.' : unavailable ?? '조회 기간에 순자산 기록이 없습니다.'}</p>
    </div>}
    {missing && valid.length > 0 && <p className="home-note">선택 기간에 비교 가능한 기록이 없는 날짜가 있습니다.</p>}
    {balanceStatus && <p className="home-note">{balanceStatus}</p>}
  </section>
}

export default function DemoAssetChart({ data, approved, date }: { data: Finance; approved: Purchase[]; date: string }) {
  const baseline = data.accounts.reduce((start, item) => item.openedOn && item.openedOn > start ? item.openedOn : start, data.ledgerStartsOn ?? date)
  const earliest = monthsBefore(date, 12)
  const start = baseline > earliest ? baseline : earliest
  const days = daysBetween(start, date)
  const startMs = Date.parse(start + 'T00:00:00Z')
  const points: AssetPoint[] = []
  let totals: Totals | null = null
  let accounts: AssetAccount[] = []
  for (let index = 0; data.accounts.length && index <= days; index++) {
    const day = new Date(startMs + index * 86_400_000).toISOString().slice(0, 10)
    const posted = approved.filter((purchase) => purchase.date <= day)
    let assets = 0n
    let liabilities = 0n
    accounts = data.accounts.map((account) => {
      const amount = BigInt(accountBalance(account, posted))
      const kind = account.kind === 'credit' ? 'liability' : 'asset'
      if (kind === 'liability') liabilities += amount
      else assets += amount
      return { id: account.id, name: account.name, kind, balance_minor: amount.toString() }
    })
    const purchaseCount = posted.filter((purchase) => purchase.date === day).length
    const source = purchaseCount ? '확정 거래 ' + purchaseCount + '건' : index === 0 ? '조회 시작 잔액' : '원장 잔액'
    points.push({ date: day, amount: (assets - liabilities).toString(), source })
    totals = { assets, liabilities }
  }
  return <AssetChart date={date} points={points} basis="샘플 원화 계좌 · 확정 거래 기준" totals={totals} accounts={accounts}
    accountHref="/demo/accounts" />
}
