import type { SupabaseClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'
import { monthEnd, monthsBefore } from '@/lib/home-dates'
import { today } from '@/lib/local-finance'
import type { MonthlyBudget } from '@/lib/monthly-budget'
import { readPages } from '@/lib/supabase/ledger-category'
import { AssetChart } from './demo-asset-chart'
import type { AssetPoint } from './demo-asset-chart'
import { BudgetSummary, CategorySpending, HomeSource } from './home-summary'
import './dashboard.css'

type LedgerSummary = {
  spending_minor: string
  purchase_count: number
  categories: { id: string; name: string; amount_minor: string }[]
}

type Account = { id: string; name: string; kind: 'asset' | 'liability'; balance_minor: string | null }
type Closing = {
  closing_month: string
  snapshot: { known_net_assets_minor: string | null; unknown_balance_count: number; accounts: { id: string }[] }
}
type ReviewRow = { status: 'pending_review' | 'duplicate_suspected'; amount_minor: string; currency: string }

const nav = [
  ['/', '◫', '금융 현황'], ['/transaction-review', '≡', '거래 검토'], ['/budgets', '◔', '월별 예산'],
  ['/account-balances', '▣', '계좌 잔액'], ['/card-installments', '↗', '카드 할부 계획'],
  ['/card-benefits', '◇', '카드 혜택'], ['/ledger-summary', '▤', '확정 원장'],
  ['/finance-settings', '⚙', '계좌·카테고리 설정'],
]

function netAssets(accounts: Account[] | null | undefined) {
  if (!accounts?.length || accounts.some((account) => account.balance_minor === null)) return null
  return accounts.reduce((sum, account) => sum + BigInt(account.balance_minor ?? '0') * (account.kind === 'liability' ? -1n : 1n), 0n).toString()
}

export default async function ConnectedDashboard({ supabase }: { supabase: SupabaseClient }) {
  const date = today()
  const month = date.slice(0, 7)
  const { data: { user }, error: sessionError } = await supabase.auth.getUser()
  const dashboard = user && !sessionError ? await Promise.all([
    supabase.rpc('summarize_confirmed_purchases', { p_month: month + '-01' }),
    supabase.rpc('get_monthly_budget', { p_month: month + '-01' }),
    supabase.rpc('list_account_balances'),
    readPages<ReviewRow>((start, end) => supabase.from('pending_transactions').select('status,amount_minor::text,currency')
      .eq('user_id', user.id).in('status', ['pending_review', 'duplicate_suspected']).order('id').range(start, end).returns<ReviewRow[]>()),
    readPages<Closing>((start, end) => supabase.from('monthly_financial_closings').select('closing_month,snapshot')
      .eq('user_id', user.id).gte('closing_month', monthsBefore(date, 12).slice(0, 7) + '-01')
      .lt('closing_month', month + '-01').order('closing_month').order('version', { ascending: false }).range(start, end).returns<Closing[]>()),
    supabase.rpc('list_account_balance_checks', { p_limit: 1 }),
  ]) : null
  const summary = dashboard?.[0].data as LedgerSummary | null | undefined
  const budget = dashboard?.[1].data as MonthlyBudget | null | undefined
  const accounts = dashboard?.[2].data as Account[] | null | undefined
  const review = dashboard?.[3]
  const checks = dashboard?.[5]
  const lastCheck = checks?.data?.[0] as { account_name: string; observed_at: string } | undefined
  const queryCount = dashboard ? [dashboard[0].error, dashboard[1].error, dashboard[2].error, review === null, dashboard[4] === null, checks?.error]
    .filter(Boolean).length : 0
  const sourceDetail = !dashboard ? '사용자 세션 필요' : queryCount ? '일부 항목 조회 실패' : '원장 조회 완료'
  const pendingCount = review?.filter((row) => row.status === 'pending_review').length ?? 0
  const reviewAmounts = new Map<string, bigint>()
  for (const row of review ?? []) {
    reviewAmounts.set(row.currency, (reviewAmounts.get(row.currency) ?? 0n) + BigInt(row.amount_minor))
  }
  const wonReview = reviewAmounts.get('KRW')
  const currentNet = netAssets(accounts)
  const accountIds = new Set(accounts?.map((account) => account.id))
  const points: AssetPoint[] = []
  for (let offset = -12; offset < 0; offset++) {
    const closingDate = monthEnd(date, offset)
    const closing = dashboard?.[4]?.find((row) => row.closing_month === closingDate.slice(0, 7) + '-01')?.snapshot
    const comparable = closing && closing.unknown_balance_count === 0 && closing.accounts.length === accountIds.size
      && closing.accounts.every((account) => accountIds.has(account.id))
    points.push({ date: closingDate, amount: comparable ? closing.known_net_assets_minor : null })
  }
  points.push({ date, amount: currentNet })
  const balanceStatus = !checks || checks.error ? '잔액 대조 기록 조회 불가' : lastCheck
    ? `최근 잔액 대조 ${lastCheck.account_name} · ${formatSeoulTime(lastCheck.observed_at)}` : '잔액 대조 기록 없음'

  return <div className="shell demo-dashboard">
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="자산 관리"><span aria-hidden="true">₩</span><strong>자산 관리</strong></Link>
      <nav aria-label="메인 메뉴">{nav.map(([href, mark, label]) => <a key={href} href={href} aria-current={href === '/' ? 'page' : undefined}>
        <span aria-hidden="true">{mark}</span><span>{label}</span>
      </a>)}</nav>
      <a className="home-demo-link" href="/demo">샘플 대시보드</a>
    </aside>
    <main>
      <div className="content">
        <div className="section-heading demo-heading">
          <h1>금융 현황</h1>
          <div className="home-heading-meta">
            <time className="demo-current-month" dateTime={month}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</time>
            <HomeSource source="Supabase 실제 데이터" detail={sourceDetail} />
          </div>
        </div>
        {!dashboard ? <section className="panel" aria-label="연결 상태">
          <p>개인 금융 현황을 보려면 인증된 사용자 세션이 필요합니다.</p>
        </section> : <>
          <div className="demo-overview">
            <BudgetSummary href="/budgets" budget={budget?.total?.amount_minor != null ? BigInt(budget.total.amount_minor) : null}
              spent={summary ? BigInt(summary.spending_minor) : null} scheduled={null} />
            <section className="panel demo-queue" aria-labelledby="connected-review">
              <div className="demo-card-heading"><h2 id="connected-review">검토할 거래</h2>
                <a className="button home-review-action" href="/transaction-review">거래 검토하기 <span aria-hidden="true">→</span></a>
              </div>
              {review ? <>
                <p className="home-queue-totals"><strong>{review.length}건</strong><span>검토 대기 {pendingCount}건 · 중복 의심 {review.length - pendingCount}건</span></p>
                <p className="home-note">원화 대기 거래 합계 <strong>{formatWon((wonReview ?? 0n).toString())}</strong></p>
                {reviewAmounts.size > Number(reviewAmounts.has('KRW')) && <p className="home-note">외화 대기 거래는 거래 검토에서 확인할 수 있습니다.</p>}
              </> : <p className="demo-empty" role="status">대기 거래를 불러오지 못했습니다.</p>}
            </section>
          </div>
          <div className="demo-overview demo-overview-charts">
            <AssetChart date={date} points={points} monthly basis="현재 원화 원장 잔액 · 이전 월은 저장된 월말 결산"
              balanceStatus={balanceStatus} unavailable={accounts?.some((account) => account.balance_minor === null)
                ? '초기 잔액이 없는 원화 계좌가 있어 순자산을 산정할 수 없습니다.' : '비교 가능한 원화 잔액 기록을 조회할 수 없습니다.'} />
            <CategorySpending net total={summary ? BigInt(summary.spending_minor) : null}
              entries={summary?.categories.map((item) => ({ ...item, amount: BigInt(item.amount_minor),
                href: '/ledger-summary?' + new URLSearchParams({ month, category: item.id }) })) ?? null} />
          </div>
          <section className="panel demo-recurring">
            <div className="demo-card-heading"><h2>이번 달 남은 정기 결제</h2></div>
            <p className="demo-empty">연결된 정기 결제 일정 데이터가 없습니다.</p>
          </section>
          <section className="panel demo-recurring" aria-labelledby="connected-accounts">
            <div className="demo-card-heading"><h2 id="connected-accounts">원화 계좌 잔액</h2><a href="/account-balances">잔액 확인</a></div>
            {!accounts ? <p className="demo-empty" role="status">계좌 잔액을 불러오지 못했습니다.</p> : accounts.length > 0
              ? <ul className="summary-list">{accounts.map((account) => <li key={account.id}>
                <div><strong>{account.name}</strong><small>{account.kind === 'asset' ? '자산' : '카드 부채'}</small></div>
                <span>{account.balance_minor === null ? '초기 잔액 필요' : formatWon(account.balance_minor)}</span>
              </li>)}</ul>
              : <p className="demo-empty">등록된 원화 계좌가 없습니다.</p>}
          </section>
        </>}
      </div>
    </main>
  </div>
}
