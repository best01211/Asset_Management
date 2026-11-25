import type { Metadata } from 'next'
import Link from 'next/link'
import ReviewWorkspace from './review-workspace'

export const metadata: Metadata = { title: '연결된 거래 검토 | 개인 금융 관리' }

export default function TransactionReviewPage() {
  return (
    <main className="recovery-shell">
      <header className="topbar">
        <Link href="/">금융 현황</Link>
        <span className="badge">Supabase 연결</span>
      </header>
      <div className="content">
        <div className="section-heading recovery-heading">
          <h1>연결된 거래 검토</h1>
          <div className="row-actions">
            <a className="button outline" href="/notification-recovery?mode=connected">알림 복구</a>
            <a className="button outline" href="/ledger-summary">확정 원장 집계</a>
          </div>
        </div>
        <ReviewWorkspace />
      </div>
    </main>
  )
}
