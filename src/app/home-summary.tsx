import { formatWon } from '@/lib/format-finance'

const won = (value: bigint) => formatWon(value.toString())

export function HomeSource({ source, detail }: { source: string; detail: string }) {
  return <div className="home-source"><strong>{source}</strong><span>{detail}</span></div>
}

export function BudgetSummary({ budget, spent, scheduled, href }: {
  budget: bigint | null; spent: bigint | null; scheduled: bigint | null; href: string
}) {
  const balance = budget !== null && spent !== null ? budget - spent : null
  const available = balance !== null && scheduled !== null ? balance - scheduled : null
  const share = (amount: bigint | null) => budget && budget > 0n && amount !== null ? Number(amount) / Number(budget) * 100 : null
  const confirmed = share(spent)
  const planned = share(scheduled)
  const usedWidth = Math.max(0, Math.min(confirmed ?? 0, 100))
  return <section className="panel demo-budget-hero" aria-labelledby="home-budget-heading">
    <div className="demo-card-heading"><h2 id="home-budget-heading">이번 달 예산</h2><a href={href}>예산 확인 <span aria-hidden="true">→</span></a></div>
    <dl className="home-budget-balances">
      <div><dt>정기 결제 반영 후 가용 예산</dt><dd className="demo-remaining" data-over={available !== null && available < 0n}>{available === null ? '산정 불가' : won(available)}</dd></div>
      <div><dt>현재 예산 잔액</dt><dd>{balance === null ? '—' : won(balance)}</dd></div>
    </dl>
    {budget !== null && budget > 0n && <div className="demo-budget-track" aria-hidden="true">
      <span className="demo-budget-confirmed" style={{ width: `${usedWidth}%` }} />
      <span className="demo-budget-planned" style={{ width: `${Math.max(0, Math.min(planned ?? 0, 100 - usedWidth))}%` }} />
    </div>}
    <dl className="demo-budget-breakdown">
      <div><dt>월 예산</dt><dd>{budget === null ? '미설정 또는 조회 불가' : won(budget)}</dd></div>
      <div><dt><i className="demo-budget-confirmed" aria-hidden="true" />확정 지출</dt><dd>{spent === null ? '조회 불가' : won(spent)} {confirmed !== null && <small>{Math.round(confirmed)}%</small>}</dd></div>
      <div><dt><i className="demo-budget-planned" aria-hidden="true" />남은 정기 결제</dt><dd>{scheduled === null ? '일정 데이터 없음' : won(scheduled)} {planned !== null && <small>{Math.round(planned)}%</small>}</dd></div>
    </dl>
    <details className="home-details"><summary>계산 근거</summary>
      <p>현재 잔액 = 월 예산 − 확정 지출<br />가용 예산 = 현재 잔액 − 남은 정기 결제</p>
    </details>
  </section>
}

export function CategorySpending({ title = '카테고리별 지출', entries, total, net = false }: {
  title?: string; entries: { id: string; name: string; amount: bigint; href: string }[] | null; total: bigint | null; net?: boolean
}) {
  const canShowShare = total !== null && total > 0n
  const sorted = entries && [...entries].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.name.localeCompare(b.name, 'ko'))
  return <section className="panel demo-spending" aria-labelledby="home-spending-heading">
    <div className="demo-card-heading"><h2 id="home-spending-heading">{title}</h2>{total !== null && <strong>{won(total)}</strong>}</div>
    {sorted?.length ? <>
      <p className="home-note">{net ? '이번 달 확정 순지출 기준 · 환불 반영' : '이번 달 확정 지출 기준'}{!canShowShare && ' · 합계가 0 이하이면 비율 표시 불가'}</p>
      <ul className="demo-category-list">{sorted.map((item) => {
        const share = canShowShare ? Number(item.amount) / Number(total) * 100 : null
        return <li key={item.id}><a href={item.href}>
          <span className="demo-category-name">{item.name}</span><strong>{won(item.amount)}</strong><span className="home-share">{share === null ? '—' : `${share.toFixed(1)}%`}</span>
          <span className="home-category-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(share ?? 0, 100))}%` }} /></span>
        </a></li>
      })}</ul>
    </> : <p className="demo-empty">{sorted ? '이번 달 확정 지출이 없습니다.' : '카테고리별 집계를 불러오지 못했습니다.'}</p>}
  </section>
}
