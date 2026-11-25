import type { Metadata } from 'next'
import OpeningBalances from './opening-balances'

export const metadata: Metadata = { title: '계좌 잔액 | 개인 금융 관리' }

export default function AccountBalancesPage() {
  return (
    <main className="recovery-shell">
      <header className="topbar">
        <a href="/ledger-summary">확정 원장 집계</a><span className="badge">Supabase 연결</span>
      </header>
      <div className="content">
        <div className="section-heading recovery-heading"><h1>계좌 잔액</h1>
          <div className="row-actions"><a className="button outline" href="/finance-settings">계좌·카테고리 설정</a>
            <a className="button outline" href="/account-activity">계좌 대조 및 거래 기록</a></div>
        </div>
        <OpeningBalances />
      </div>
    </main>
  )
}
