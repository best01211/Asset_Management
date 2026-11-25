import type { Metadata } from 'next'
import BudgetWorkspace from './workspace'

export const metadata: Metadata = { title: '월별 예산 | 개인 금융 관리' }

export default function BudgetsPage() {
  return <main className="recovery-shell">
    <header className="topbar"><div className="row-actions"><a href="/ledger-summary">확정 원장 집계</a>
      <a href="/finance-settings">계좌·카테고리 설정</a></div><span className="badge">Supabase 연결</span></header>
    <div className="content"><BudgetWorkspace /></div>
  </main>
}
