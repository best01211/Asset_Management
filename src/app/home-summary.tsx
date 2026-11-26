import { homeWon as won } from './editorial-home'

export function HomeSource({ source, detail }: { source: string; detail: string }) {
  return <div className="home-source"><strong>{source}</strong><span>{detail}</span></div>
}

export function BudgetSummary({ budget, spent, scheduled, href, scheduleNotice }: {
  budget: bigint | null; spent: bigint | null; scheduled: bigint | null; href: string; scheduleNotice?: string
}) {
  const balance = budget !== null && spent !== null ? budget - spent : null
  const available = balance !== null && scheduled !== null ? balance - scheduled : null
  const confirmed = budget !== null && budget > 0n && spent !== null ? Number(spent) / Number(budget) * 100 : null
  const usedWidth = Math.max(0, Math.min(confirmed ?? 0, 100))
  return <section className="home-budget" aria-labelledby="home-budget-heading">
    <div className="home-section-heading"><h2 id="home-budget-heading">이번 달 실제 남은 예산</h2><a href={href}>예산 확인 <span aria-hidden="true">→</span></a></div>
    <div className="home-budget-body">
      <div>
        <p className="home-budget-value" data-unavailable={available === null}>{available === null ? '산정 불가' : won(available)}</p>
        <p className="home-budget-caption">{available === null
          ? balance !== null && scheduled === null ? '정기 결제 반영 전 ' + won(balance) : '월 목표 또는 확정 지출을 확인해 주세요.'
          : available < 0n ? '정기 결제 반영 후 월 목표 초과' : available === 0n ? '정기 결제 반영 후 남은 예산 없음' : '정기 결제까지 반영한 지출 여유'}</p>
      </div>
      <dl className="home-budget-breakdown">
        <div><dt>월 목표 사용량</dt><dd>{budget === null ? '미설정 또는 조회 불가' : won(budget)}</dd></div>
        <div><dt>확정 지출</dt><dd>{spent === null ? '조회 불가' : won(spent)}</dd></div>
        <div><dt>미결제 정기 결제</dt><dd>{scheduled === null ? scheduleNotice ?? '일정 데이터 없음' : won(scheduled)}</dd></div>
      </dl>
    </div>
    <div className="home-budget-meter">
      <span>{confirmed === null ? '사용률 산정 불가' : `${confirmed.toFixed(1)}% 사용`}</span>
      {confirmed !== null && <div className="home-budget-track" aria-hidden="true"><span style={{ width: `${usedWidth}%` }} /></div>}
    </div>
    <p className="home-budget-note">월 목표 기준 · 은행 계좌 잔액은 순자산에서 확인</p>
  </section>
}

export function CategorySpending({ entries, total, net = false }: {
  entries: { id: string; name: string; amount: bigint; href: string }[] | null; total: bigint | null; net?: boolean
}) {
  const canShowShare = total !== null && total > 0n
  const sorted = entries && [...entries].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.name.localeCompare(b.name, 'ko'))
  return <section className="home-spending" aria-labelledby="home-spending-heading">
    <h2 id="home-spending-heading">이번 달 주요 소비 카테고리</h2>
    {sorted?.length ? <>
      <p className="home-note">{net ? '이번 달 확정 순지출 기준 · 환불 반영' : '이번 달 확정 지출 기준'}{!canShowShare && ' · 합계가 0 이하이면 비율 표시 불가'}</p>
      <ul className="home-category-list">{sorted.slice(0, 5).map((item) => {
        const share = canShowShare ? Number(item.amount) / Number(total) * 100 : null
        return <li key={item.id}><a href={item.href}>
          <span className="home-category-name">{item.name}</span><strong>{won(item.amount)}</strong><span className="home-share">{share === null ? '—' : `${share.toFixed(1)}%`}</span>
          <span className="home-category-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(share ?? 0, 100))}%` }} /></span>
        </a></li>
      })}</ul>
    </> : <p className="home-empty">{sorted ? '이번 달 확정 지출이 없습니다.' : '카테고리별 집계를 불러오지 못했습니다.'}</p>}
  </section>
}
