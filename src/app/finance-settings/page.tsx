import type { Metadata } from 'next'
import FinanceSettings from './workspace'

export const metadata: Metadata = { title: '계좌·카테고리 설정 | 개인 금융 관리' }

export default function FinanceSettingsPage() {
  return <main className="recovery-shell">
    <header className="topbar"><div className="row-actions"><a href="/account-balances">계좌 잔액</a>
      <a href="/budgets">월별 예산</a></div><span className="badge">Supabase 연결</span></header>
    <div className="content">
      <div className="section-heading recovery-heading"><h1>계좌·카테고리 설정</h1>
        <div className="row-actions dashboard-nav">
          <a className="button outline" href="/category-rules">가맹점 분류 규칙</a>
          <a className="button outline" href="/card-benefits">카드 혜택</a>
        </div>
      </div>
      <FinanceSettings />
    </div>
  </main>
}
