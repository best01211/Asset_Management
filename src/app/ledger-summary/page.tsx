import type { Metadata } from 'next'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'
import { createClient } from '@/lib/supabase/server'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { loadLedgerCategory } from '@/lib/supabase/ledger-category'
import { isUuid } from '@/lib/supabase/pending-expenses'

export const metadata: Metadata = { title: '확정 원장 집계 | 개인 금융 관리' }

type Summary = {
  purchase_count: number
  spending_minor: string
  gross_spending_minor: string
  refund_minor: string
  fee_minor: string
  categories: { id: string; name: string; amount_minor: string }[]
  accounts: { id: string; name: string; kind: 'asset' | 'liability'; change_minor: string }[]
}

async function ledgerSummary(month: string, category: string | null) {
  if (!isBudgetMonth(month)) {
    return '조회할 월을 다시 선택해 주세요.'
  }
  const supabase = await createClient()
  if (!supabase) return 'Supabase 연결이 설정되지 않았습니다.'
  const { data: session, error: authError } = await supabase.auth.getUser()
  if (authError || !session.user) return '확정 원장 집계를 보려면 인증된 사용자 세션이 필요합니다.'
  const { data, error } = await supabase.rpc('summarize_confirmed_purchases', { p_month: month + '-01' })
  if (error || !data) return '확정 원장 집계를 불러오지 못했습니다. 다시 조회해 주세요.'
  const summary = data as Summary
  const selectedCategory = summary.categories.find((item) => item.id === category)
  const transactions = selectedCategory ? await loadLedgerCategory(supabase, session.user.id, month, selectedCategory.id) : null
  return { summary, selectedCategory, transactions }
}

export default async function LedgerSummaryPage({
  searchParams,
}: { searchParams: Promise<{ month?: string | string[]; category?: string | string[] }> }) {
  const { month: requested, category } = await searchParams
  const current = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date())
  const selected = typeof requested === 'string' ? requested : current
  const result = await ledgerSummary(selected, isUuid(category) ? category : null)
  const summary = typeof result !== 'string' ? result.summary : null

  return (
    <main className="recovery-shell">
      <header className="topbar">
        <div className="row-actions"><a href="/transaction-review">연결된 거래 검토</a><a href="/account-balances">계좌 잔액</a>
          <a href="/budgets">월별 예산</a></div>
        <span className="badge">Supabase 연결</span>
      </header>
      <div className="content">
        <div className="section-heading recovery-heading">
          <h1>확정 원장 집계</h1>
          <form className="ledger-month" method="get">
            <label>조회 월<input name="month" type="month" min="1900-01" max="9998-12" defaultValue={selected} required /></label>
            <button type="submit">조회</button>
          </form>
        </div>
        {typeof result === 'string' || !summary ? <section className="panel" aria-label="원장 상태"><p>{typeof result === 'string' ? result : '원장 조회 결과가 없습니다.'}</p></section> : <>
          <div className="row-actions ledger-export">
            <a className="button outline" href={'/api/ledger-export?kind=transactions&month=' + selected}>확정 거래 CSV</a>
            <a className="button outline" href={'/api/ledger-export?kind=entries&month=' + selected}>분개 CSV</a>
          </div>
          {result.selectedCategory && <section className="panel budget-category-panel" aria-labelledby="category-transactions">
            <div className="section-heading"><h2 id="category-transactions">{result.selectedCategory.name} 확정 거래</h2>
              <a href={'/ledger-summary?month=' + selected}>카테고리 필터 해제</a></div>
            {result.transactions === null ? <p role="status">카테고리 거래를 불러오지 못했습니다.</p> : result.transactions.length ? <div className="table-scroll"><table>
              <thead><tr><th scope="col">거래일</th><th scope="col">거래</th><th scope="col" className="numeric">카테고리 반영 금액</th></tr></thead>
              <tbody>{result.transactions.map((item) => <tr key={item.id}>
                <td><time dateTime={item.date}>{formatSeoulTime(item.date)}</time></td>
                <th scope="row">{item.description}{item.kind === 'purchase_refund' ? ' · 환불' : item.kind === 'transfer_fee' ? ' · 이체 수수료' : ''}</th>
                <td className="numeric">{formatWon(item.amount)}</td>
              </tr>)}</tbody>
            </table></div> : <p>이 카테고리에 해당하는 거래가 없습니다.</p>}
          </section>}
          <section className="metric primary" aria-labelledby="ledger-purchases-title">
            <h2 id="ledger-purchases-title">월 순지출</h2>
            <strong>{formatWon(summary.spending_minor)}</strong>
            <p>구매 {formatWon(summary.gross_spending_minor)} · 환불 {formatWon(summary.refund_minor)} · 이체 수수료 {formatWon(summary.fee_minor)}</p>
          </section>
          <div className="detail-grid">
            <section className="panel" aria-labelledby="ledger-categories-title">
              <h2 id="ledger-categories-title">카테고리별 확정 지출</h2>
              {summary.categories.length ? <ul className="summary-list">
                {summary.categories.map((item) => <li key={item.id}><a aria-current={item.id === result.selectedCategory?.id ? 'true' : undefined}
                  href={'/ledger-summary?' + new URLSearchParams({ month: selected, category: item.id })}>{item.name}</a><strong>{formatWon(item.amount_minor)}</strong></li>)}
              </ul> : <p className="recovery-message">이 달의 지출·환불 기록이 없습니다.</p>}
            </section>
            <section className="panel" aria-labelledby="ledger-accounts-title">
              <h2 id="ledger-accounts-title">월 계좌 변화</h2>
              <p className="recovery-message">조회 월의 확정 원장 기록에 따른 증감입니다.</p>
              {summary.accounts.length ? <ul className="summary-list">
                {summary.accounts.map((item) => <li key={item.id}><div><strong>{item.name}</strong>
                  <small>{item.kind === 'asset' ? '자산 계좌' : '카드 부채'}</small>
                </div><strong>{BigInt(item.change_minor) > 0 ? '+' : ''}{formatWon(item.change_minor)}</strong></li>)}
              </ul> : <p className="recovery-message">이 달에 변동한 계좌가 없습니다.</p>}
            </section>
          </div>
        </>}
      </div>
    </main>
  )
}
