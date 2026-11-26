'use client'

import Link from 'next/link'
import { useState } from 'react'
import { budgetPercent, budgetWon, differenceRate } from '@/lib/monthly-budget'
import type { BudgetAnalysis, BudgetCategory, BudgetWorkspaceData } from '@/lib/monthly-budget'
import { formatMinor } from '@/lib/transaction-history'

export const statusNames = { over: '초과', warning: '주의', normal: '정상', unknown: '예측 불가', unset: '미설정' } as const
export const signedAmount = (value: bigint) => (value > 0n ? '+' : '') + budgetWon(value)

function comparisonText(current: bigint, prior: bigint | null) {
  if (prior === null) return '비교 데이터 부족'
  const rate = differenceRate(current, prior)
  return signedAmount(current - prior) + (rate === null ? '' : ` · ${rate > 0n ? '+' : ''}${budgetPercent(rate)}`)
}

export function BudgetChart({ chart }: { chart: BudgetAnalysis['chart'] }) {
  const [index, setIndex] = useState<number | null>(null)
  if (!chart.length) return <p className="budget-empty">확정 지출 기록이 쌓이면 소비 추이를 표시합니다.</p>
  const values = chart.flatMap((point) => [point.amount, point.target]).filter((value): value is bigint => value !== null)
  const minimum = values.reduce((a, b) => a < b ? a : b, 0n)
  const maximum = values.reduce((a, b) => a > b ? a : b, 0n)
  const span = maximum - minimum || 1n
  const x = (day: number) => 16 + day / (chart.length - 1) * 968
  const y = (value: bigint) => 214 - Number((value - minimum) * 1980n / span) / 10
  const reference = chart.flatMap((point, day) => point.target === null ? [] : [`${x(day)},${y(point.target)}`]).join(' ')
  const cumulative = chart.flatMap((point, day) => point.amount === null ? []
    : [day === 0 ? `M ${x(day)} ${y(point.amount)}` : `H ${x(day)} V ${y(point.amount)}`]).join(' ')
  const lastActual = chart.findLastIndex((point) => point.amount !== null)
  const selected = index === null ? lastActual : Math.min(index, chart.length - 1)
  const current = chart[selected]
  return <div className="budget-chart">
    <div className="budget-chart-legend"><span>확정 누적 지출</span>{chart[0].target !== null && <span>균등 사용 참고선</span>}</div>
    <div className="budget-chart-frame" tabIndex={0} aria-label="소비 추이. 방향키로 날짜 탐색"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        setIndex(event.key === 'Home' ? 0 : event.key === 'End' ? chart.length - 1
          : Math.max(0, Math.min(chart.length - 1, selected + (event.key === 'ArrowRight' ? 1 : -1))))
      }}>
      <div className="budget-chart-scale" aria-hidden="true">{[maximum, minimum + span / 2n, minimum].map((value, i) => <span key={i}>{budgetWon(value)}</span>)}</div>
      <svg viewBox="0 0 1000 230" preserveAspectRatio="none" aria-hidden="true" onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        setIndex(Math.max(0, Math.min(chart.length - 1, Math.round(((event.clientX - bounds.left) / bounds.width * 1000 - 16) / 968 * (chart.length - 1)))))
      }}>
        {[16, 115, 214].map((level) => <line key={level} x1="0" x2="1000" y1={level} y2={level} className="budget-chart-grid" />)}
        {reference && <polyline className="budget-chart-target" points={reference} />}
        <path className="budget-chart-actual" d={cumulative} />
        {current.amount !== null && <line className="budget-chart-cursor" x1={x(selected)} x2={x(selected)} y1="16" y2="214" />}
        {current.amount !== null && <circle className="budget-chart-point" cx={x(selected)} cy={y(current.amount)} r="5" />}
        {current.target !== null && <circle className="budget-chart-reference" cx={x(selected)} cy={y(current.target)} r="4" />}
      </svg>
    </div>
    <div className="budget-chart-axis" aria-hidden="true"><span>1일</span><span>10일</span><span>20일</span><span>{chart.length}일</span></div>
    <p className="budget-chart-tooltip" aria-live="polite"><time dateTime={current.day}>{current.day}</time>
      <span>누적 지출 <strong>{current.amount === null ? '—' : budgetWon(current.amount)}</strong></span>
      {current.target !== null && <span>참고선 <strong>{budgetWon(current.target)}</strong></span>}
    </p>
    {chart[0].target !== null && <p className="budget-note">참고선은 월 목표를 날짜별로 균등하게 나눈 금액입니다.</p>}
  </div>
}

export function BudgetForecastBasis({ data, analysis }: { data: BudgetWorkspaceData; analysis: BudgetAnalysis }) {
  const { closed, active, projected, spent, pendingWon, foreign } = analysis
  return <section className="budget-section budget-forecast-basis" aria-labelledby="budget-forecast-basis">
    <h2 id="budget-forecast-basis">월말 예상 근거</h2>
    {closed ? <p className="budget-note">종료된 달에는 월말 확정 순지출을 표시합니다.</p>
      : <>
        <p className="budget-note">확정 지출 + 미결제 정기 결제 + 남은 기간의 예상 변동 지출</p>
        {projected === null ? <p className="budget-note">{foreign ? '미결제 외화 회차의 환산 기준이 필요합니다.'
          : !active ? '진행 중인 달에 월말 지출을 예상합니다.' : '직전 완료 월의 변동 지출 기록이 충분할 때 예상값을 표시합니다.'}</p>
          : <dl className="budget-forecast-parts">
            <div><dt>확정 지출</dt><dd>{budgetWon(spent)}</dd></div>
            <div><dt>미결제 정기 결제</dt><dd>{budgetWon(pendingWon)}</dd></div>
            <div><dt>남은 기간의 예상 변동 지출</dt><dd>{budgetWon(projected - spent - pendingWon)}</dd></div>
          </dl>}
        {projected !== null && data.previous && <p className="budget-note">{data.previous.month}의 일평균 변동 지출에 이번 달 남은 일수를 곱합니다.</p>}
      </>}
  </section>
}

export function BudgetRisk({ data, analysis, choose }: { data: BudgetWorkspaceData; analysis: BudgetAnalysis; choose: (id: string) => void }) {
  const { pending, scheduled } = data
  const risk = analysis.categories.filter((item) => item.status === 'over' || item.status === 'warning')
  return <section className="budget-section budget-risk-section" aria-labelledby="budget-risks">
    <h2 id="budget-risks">예산 위험과 예정 지출</h2>
    <div className="budget-two-columns">
      <div className="budget-subsection"><h3>승인 대기 거래</h3>
        <p><strong>{pending.count}건 · {budgetWon(BigInt(pending.won_minor))}</strong></p>
        {pending.duplicate_count > 0 && <p className="budget-note">중복 의심 {pending.duplicate_count}건 별도 검토</p>}
        {pending.foreign_count > 0 && <p className="budget-note">대기 건수에 외화 {pending.foreign_count}건 포함 · 금액은 원화만 표시</p>}
        <p className="budget-note">승인 후 예산과 정기 결제 연결 상태에 반영됩니다.</p>
        <Link className="budget-link" href={'/transactions?' + new URLSearchParams({ tab: 'review', month: data.month })}>거래 검토 보기</Link>
      </div>
      <div className="budget-subsection"><h3>주의·초과 카테고리</h3>
        {risk.length ? <ul className="budget-risk-list">{risk.map((item) => <li key={item.category_id}>
          <button type="button" onClick={() => choose(item.category_id)}><strong>{item.name}</strong><span className="budget-status" data-tone={item.status}>{statusNames[item.status]}</span></button>
          <span>확정 {budgetWon(item.actual)} · 예상 {item.projected === null ? '—' : budgetWon(item.projected)}</span>
          {item.limit !== null && item.actual > item.limit ? <small>확정 초과 {budgetWon(item.actual - item.limit)}</small>
            : item.limit !== null && item.projected !== null && item.projected > item.limit && <small>예상 초과 {budgetWon(item.projected - item.limit)}</small>}
        </li>)}</ul> : <p className="budget-note">현재 확인된 주의·초과 카테고리가 없습니다.</p>}
      </div>
    </div>
    <details className="budget-disclosure"><summary>미결제 정기 결제 <span>{scheduled.length}회차</span></summary>
      {scheduled.length ? <ul className="budget-risk-list">{scheduled.map((item) => <li key={item.id}>
        <Link className="budget-link" href={'/recurring-payments?' + new URLSearchParams({ month: data.month, id: item.service_id, occurrence: item.id })}>{item.name}</Link>
        <span><time dateTime={item.due_on}>{item.due_on}</time> · {item.account_name ?? '결제 수단 미지정'} · {formatMinor(item.remaining_minor, item.currency)}</span>
      </li>)}</ul> : <p className="budget-note">남은 정기 결제 예정액이 없습니다.</p>}
    </details>
  </section>
}

export function categoryComparison(item: BudgetCategory) {
  return comparisonText(item.comparing, item.previous)
}

export function BudgetComparison({ data, analysis }: { data: BudgetWorkspaceData; analysis: BudgetAnalysis }) {
  const [order, setOrder] = useState<'up' | 'down'>('up')
  const compared = analysis.categories.flatMap((item) => item.previous !== null ? [{ item, diff: item.comparing - item.previous }] : [])
  const sorted = [...compared].sort((a, b) => a.diff === b.diff ? 0 : (a.diff > b.diff) === (order === 'up') ? -1 : 1)
  const changed = compared.filter(({ diff, item }) => diff !== 0n || item.comparing !== 0n)
  const top = [...changed].sort((a, b) => {
    const first = a.diff < 0n ? -a.diff : a.diff
    const second = b.diff < 0n ? -b.diff : b.diff
    return first === second ? 0 : first > second ? -1 : 1
  }).slice(0, 3)
  return <section className="budget-section" aria-labelledby="budget-last-month">
    <h2 id="budget-last-month">지난달 소비 비교</h2>
    {analysis.previous === null || !data.previous || !analysis.cutoff || !analysis.previousEnd ? <p className="budget-empty">비교할 지난달 확정 지출 기록이 부족합니다.</p> : <>
      <p className="budget-note">{data.month}-01 ~ {analysis.cutoff} / {data.previous.month}-01 ~ {analysis.previousEnd}</p>
      <dl className="budget-comparison-totals"><div><dt>조회 기간 지출</dt><dd>{budgetWon(analysis.comparisonTotal)}</dd></div>
        <div><dt>지난 비교 기간 지출</dt><dd>{budgetWon(analysis.previous)}</dd></div>
        <div><dt>증감</dt><dd>{comparisonText(analysis.comparisonTotal, analysis.previous)}</dd></div></dl>
      {top.length > 0 && <ul className="budget-risk-list">{top.map(({ item, diff }) => <li key={item.category_id}><strong>{item.name}</strong><span>{signedAmount(diff)}</span></li>)}</ul>}
      <details className="budget-disclosure"><summary>전체 비교 보기</summary>
        <label>정렬<select value={order} onChange={(event) => setOrder(event.target.value === 'up' ? 'up' : 'down')}><option value="up">증가액순</option><option value="down">감소액순</option></select></label>
        {sorted.length ? <div className="table-scroll"><table><thead><tr><th scope="col">카테고리</th><th scope="col">조회 기간</th><th scope="col">지난 기간</th><th scope="col">증감</th></tr></thead>
          <tbody>{sorted.map(({ item }) => <tr key={item.category_id}><th scope="row">{item.name}</th><td>{budgetWon(item.comparing)}</td><td>{budgetWon(item.previous!)}</td><td>{categoryComparison(item)}</td></tr>)}</tbody>
        </table></div> : <p className="budget-note">기간 간 지출이 바뀐 카테고리가 없습니다.</p>}
      </details>
    </>}
  </section>
}

export function BudgetInsights({ data, analysis }: { data: BudgetWorkspaceData; analysis: BudgetAnalysis }) {
  const insights: { text: string; category?: string }[] = []
  const largest = analysis.categories.filter((item) => item.actual > 0n).sort((a, b) => a.actual === b.actual ? 0 : a.actual > b.actual ? -1 : 1)[0]
  const changed = analysis.categories.find((item) => item.previous !== null && item.comparing > item.previous && item !== largest)
  if (largest && analysis.spent > 0n && largest.actual <= analysis.spent) insights.push({ category: largest.name,
    text: `${largest.name} 지출이 확정 순지출의 ${budgetPercent(largest.actual * 1000n / analysis.spent)}를 차지합니다. 집중된 거래를 확인해 보세요.` })
  if (changed && changed.previous !== null) insights.push({ category: changed.name,
    text: `${changed.name} 지출이 지난 비교 기간보다 ${budgetWon(changed.comparing - changed.previous)} 늘었습니다. 관련 거래에서 변화의 원인을 살펴볼 수 있습니다.` })
  if (analysis.pendingWon > 0n && analysis.remaining !== null) insights.push({ text: `원화 정기 결제 예정액 ${budgetWon(analysis.pendingWon)}을 반영하면 남은 예산은 ${budgetWon(analysis.remaining)}입니다.` })
  return <section className="budget-section" aria-labelledby="budget-insights">
    <h2 id="budget-insights">소비 인사이트</h2>
    {insights.length ? <ul className="budget-insights">{insights.slice(0, 3).map((item) => <li key={item.text}><p>{item.text}</p>
      <button type="button" className="budget-link" onClick={() => window.dispatchEvent(new CustomEvent('finance-assistant:open', {
        detail: `${data.month} 월별 예산${item.category ? ` · ${item.category}` : ''}\n${item.text}\n이 지출을 어떻게 점검하면 좋을지 알려줘.`,
      }))}>자세히 질문하기</button></li>)}</ul> : <p className="budget-empty">분석할 지출과 예산 기록이 쌓이면 인사이트를 표시합니다.</p>}
  </section>
}
