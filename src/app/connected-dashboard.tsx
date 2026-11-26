import type { SupabaseClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { formatSeoulTime } from '@/lib/format-finance'
import { monthEnd, monthsBefore } from '@/lib/home-dates'
import { today } from '@/lib/local-finance'
import type { MonthlyBudget } from '@/lib/monthly-budget'
import { connectedNavigation } from '@/lib/finance-navigation'
import { readPages } from '@/lib/supabase/ledger-category'
import { monthTotals } from '@/lib/recurring-payments'
import type { RecurringMonth } from '@/lib/recurring-payments'
import { AssetChart } from './demo-asset-chart'
import type { AssetPoint } from './demo-asset-chart'
import { EditorialHome, RecurringPayments, ReviewPanel } from './editorial-home'
import { BudgetSummary, CategorySpending, HomeSource } from './home-summary'
import SettingsWindow from './settings-window'
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

function assetTotals(accounts: Account[] | null | undefined) {
  if (!accounts?.length || accounts.some((account) => account.balance_minor === null)) return null
  let assets = 0n
  let liabilities = 0n
  for (const account of accounts) {
    const amount = BigInt(account.balance_minor ?? '0')
    if (account.kind === 'liability') liabilities += amount
    else assets += amount
  }
  return { assets, liabilities }
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
    supabase.rpc('list_notification_recovery', { p_limit: 1 }),
    supabase.rpc('read_recurring_month', { p_month: month + '-01', p_home: true }),
  ]) : null
  const recurringData = dashboard?.[7].data as (RecurringMonth & { ledger_summary: LedgerSummary }) | null | undefined
  const recurring = Array.isArray(recurringData?.occurrences) && Array.isArray(recurringData?.alerts) ? recurringData : null
  const summary = recurring?.ledger_summary ?? dashboard?.[0].data as LedgerSummary | null | undefined
  const scheduledTotals = recurring && monthTotals(recurring.occurrences)
  const foreignScheduled = scheduledTotals && [...scheduledTotals].some(([currency, total]) => currency !== 'KRW' && total.remaining > 0n)
  const scheduled = scheduledTotals && !foreignScheduled ? scheduledTotals.get('KRW')?.remaining ?? 0n : null
  const budget = dashboard?.[1].data as MonthlyBudget | null | undefined
  const accounts = dashboard?.[2].data as Account[] | null | undefined
  const review = dashboard?.[3]
  const checks = dashboard?.[5]
  const lastCheck = checks?.data?.[0] as { account_name: string; observed_at: string } | undefined
  const recovery = dashboard?.[6]
  const queryCount = dashboard ? [dashboard[0].error, dashboard[1].error, dashboard[2].error, review === null, dashboard[4] === null, checks?.error, recovery?.error]
    .filter(Boolean).length : 0
  const sourceDetail = !dashboard ? '사용자 세션 필요' : queryCount ? '일부 항목 조회 실패' : '원장 조회 완료'
  const pendingCount = review?.filter((row) => row.status === 'pending_review').length ?? 0
  const reviewAmounts = new Map<string, bigint>()
  for (const row of review ?? []) {
    reviewAmounts.set(row.currency, (reviewAmounts.get(row.currency) ?? 0n) + BigInt(row.amount_minor))
  }
  const wonReview = reviewAmounts.get('KRW')
  const totals = assetTotals(accounts)
  const accountIds = new Set(accounts?.map((account) => account.id))
  const points: AssetPoint[] = []
  for (let offset = -12; offset < 0; offset++) {
    const closingDate = monthEnd(date, offset)
    const closing = dashboard?.[4]?.find((row) => row.closing_month === closingDate.slice(0, 7) + '-01')?.snapshot
    const comparable = closing && closing.unknown_balance_count === 0 && closing.accounts.length === accountIds.size
      && closing.accounts.every((account) => accountIds.has(account.id))
    points.push({ date: closingDate, amount: comparable ? closing.known_net_assets_minor : null, source: comparable ? '저장된 월말 결산' : undefined })
  }
  points.push({ date, amount: totals ? (totals.assets - totals.liabilities).toString() : null, source: '현재 원화 원장 잔액' })
  const balanceStatus = !checks || checks.error ? '잔액 대조 기록 조회 불가' : lastCheck
    ? `최근 잔액 대조 ${lastCheck.account_name} · ${formatSeoulTime(lastCheck.observed_at)}` : '잔액 대조 기록 없음'

  return <div className="shell demo-dashboard editorial-home">
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="자산 관리"><span aria-hidden="true">₩</span><strong>자산 관리</strong></Link>
      <nav aria-label="메인 메뉴">{connectedNavigation.map(([href, mark, label]) => <a key={href} href={href} aria-current={href === '/' ? 'page' : undefined}>
        <span aria-hidden="true">{mark}</span><span>{label}</span>
      </a>)}</nav>
      <a className="home-demo-link" href="/demo">샘플 대시보드</a>
    </aside>
    <main id="overview">
      <div className="content">
        <div className="section-heading demo-heading">
          <h1>금융 현황</h1>
          <div className="home-heading-meta">
            <time className="demo-current-month" dateTime={month}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</time>
            <HomeSource source="Supabase 실제 데이터" detail={sourceDetail} />
            <SettingsWindow />
          </div>
        </div>
        {!dashboard ? <section className="panel" aria-label="연결 상태">
          <p>개인 금융 현황을 보려면 인증된 사용자 세션이 필요합니다.</p>
        </section> : <EditorialHome
          budget={<BudgetSummary href="/budgets" budget={budget?.total?.amount_minor != null ? BigInt(budget.total.amount_minor) : null}
            spent={summary ? BigInt(summary.spending_minor) : null} scheduled={scheduled}
            scheduleNotice={foreignScheduled ? '외화 환산 기준 필요' : undefined} />}
          assets={<AssetChart date={date} points={points} monthly basis="원화 계좌 잔액 · 이전 월은 저장된 월말 결산"
            totals={totals} accounts={accounts} accountHref="/account-balances" balanceStatus={balanceStatus}
            unavailable={accounts?.some((account) => account.balance_minor === null)
              ? '초기 잔액이 없는 원화 계좌가 있어 전체 잔액을 산정할 수 없습니다.' : '비교 가능한 원화 잔액 기록을 조회할 수 없습니다.'} />}
          review={<ReviewPanel href="/transactions?tab=review" count={review?.length ?? null} amount={review ? wonReview ?? 0n : null}>
            {review && review.length > 0 && <p className="home-note">검토 대기 {pendingCount}건{review.length > pendingCount && <> · <strong className="home-review-status">중복 의심 {review.length - pendingCount}건</strong></>}</p>}
            {reviewAmounts.size > Number(reviewAmounts.has('KRW')) && <p className="home-note">외화 거래는 거래 검토에서 확인할 수 있습니다.</p>}
            {Array.isArray(recovery?.data) && recovery.data.length > 0 &&
              <a className="home-review-status" href="/notification-recovery?mode=connected">복구할 알림 확인</a>}
          </ReviewPanel>}
          recurring={<RecurringPayments date={date} href="/recurring-payments"
            unread={recurring?.alerts.filter((alert) => !alert.read_at).length}
            payments={recurring?.occurrences.filter((item) => BigInt(item.remaining_minor) > 0n).map((item) => ({
              id: item.id, name: item.name, due: item.due_on, amount: item.remaining_minor, currency: item.currency,
              href: '/recurring-payments?' + new URLSearchParams({ month, id: item.service_id, occurrence: item.id }),
            })) ?? null} />}
          categories={<CategorySpending net total={summary ? BigInt(summary.spending_minor) : null}
            entries={summary?.categories.map((item) => ({ ...item, amount: BigInt(item.amount_minor),
              href: '/transactions?' + new URLSearchParams({ month, category: item.id }) })) ?? null} />}
        />}
      </div>
    </main>
  </div>
}
