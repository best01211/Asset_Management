import type { Metadata } from 'next'
import Link from 'next/link'
import type { CardInstallment, CardInstallmentPlan } from '@/lib/card-installments'
import { formatWon } from '@/lib/format-finance'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { createClient } from '@/lib/supabase/server'
import PlanEditor from './plan-editor'

export const metadata: Metadata = { title: '카드 할부 청구 계획 | 개인 금융 관리' }
export const dynamic = 'force-dynamic'

async function readPlans(month: string, purchaseId: unknown) {
  const supabase = await createClient()
  if (!supabase) return { error: 'Supabase 연결이 설정되지 않았습니다.' }
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { error: '인증된 사용자 세션이 필요합니다.' }
  const [schedule, purchase] = await Promise.all([
    supabase.rpc('list_card_installments', { p_month: month + '-01' }),
    isUuid(purchaseId) ? supabase.rpc('get_card_installment_plan', { p_purchase_id: purchaseId }) : null,
  ])
  return {
    schedule: schedule.error ? null : schedule.data as CardInstallment[],
    plan: purchase?.data as CardInstallmentPlan | null,
    planError: purchaseId !== undefined && !purchase?.data,
  }
}

export default async function CardInstallmentsPage({ searchParams }: {
  searchParams: Promise<{ month?: string | string[]; purchase_id?: string | string[] }>
}) {
  const params = await searchParams
  const currentMonth = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date())
  const month = isBudgetMonth(params.month) ? params.month : currentMonth
  const { error, schedule, plan, planError } = await readPlans(month, params.purchase_id)
  const total = schedule?.reduce((sum, item) => sum + BigInt(item.principal_minor ?? '0') + BigInt(item.fee_minor ?? '0'), 0n)

  return <main className="recovery-shell">
    <header className="topbar"><div className="row-actions">
      <Link href="/">금융 현황</Link><a href="/transaction-review">거래 검토</a><a href="/account-activity">카드 대금 납부 기록</a>
    </div></header>
    <div className="content">
      <div className="section-heading recovery-heading">
        <h1>카드 할부 청구 계획</h1>
        <form className="ledger-month" method="get">
          {isUuid(params.purchase_id) && <input type="hidden" name="purchase_id" value={params.purchase_id} />}
          <label>청구 월<input name="month" type="month" min="1900-01" max="9998-12" defaultValue={month} required /></label>
          <button type="submit">조회</button>
        </form>
      </div>
      {error ? <section className="panel"><p role="status">{error}</p></section> : <div className="detail-grid">
        <section className="panel" aria-labelledby="installment-schedule">
          <h2 id="installment-schedule">{month} 예상 청구액</h2>
          {schedule ? <>
            <p><strong>{formatWon(String(total))}</strong> · 계획 원금과 예상 수수료 합계</p>
            <p>실제 청구·납부는 카드 명세서와 원장에서 확인합니다.</p>
            {schedule.length === 0 ? <p>이 달의 할부 계획이 없습니다.</p> :
              <ul className="summary-list">{schedule.map((item) => <li key={item.purchase_id}>
                <div><a href={'/card-installments?' + new URLSearchParams({ month, purchase_id: item.purchase_id })}>{item.merchant}</a>
                  <small>{item.account_name} · {item.payment_number}/{item.payment_count}회차</small></div>
                {item.needs_review ? <span>환불 후 재확인 필요</span> : <div className="numeric">
                  <strong>{formatWon(item.principal_minor ?? '0')}</strong>
                  {item.fee_minor && item.fee_minor !== '0' && <small>예상 수수료 {formatWon(item.fee_minor)}</small>}
                </div>}
              </li>)}</ul>}
          </> : <p role="status">청구 계획을 불러오지 못했습니다.</p>}
        </section>
        {plan ? <PlanEditor key={plan.purchase_id} initialPlan={plan} /> : <section className="panel">
          <h2>할부 계획 등록</h2>
          <p>{planError ? '할부 계획을 연결할 신용카드 구매를 찾지 못했습니다.' : '확정된 신용카드 구매에서 할부 계획을 등록할 수 있습니다.'}</p>
          <a href="/transaction-review">거래 검토 열기</a>
        </section>}
      </div>}
    </div>
  </main>
}
