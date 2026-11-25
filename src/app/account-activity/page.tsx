import type { Metadata } from 'next'
import AccountActivityWorkspace from './workspace'

export const metadata: Metadata = { title: '계좌 대조 및 거래 기록 | 개인 금융 관리' }

export default async function AccountActivityPage({
  searchParams,
}: { searchParams: Promise<{ purchase_id?: string | string[] }> }) {
  const purchaseId = (await searchParams).purchase_id
  return <main className="recovery-shell">
    <header className="topbar"><div className="row-actions"><a href="/account-balances">계좌 잔액</a>
      <a href="/transaction-review">연결된 거래 검토</a></div><span className="badge">Supabase 연결</span></header>
    <div className="content">
      <div className="section-heading recovery-heading"><h1>계좌 대조 및 거래 기록</h1></div>
      <AccountActivityWorkspace purchaseId={typeof purchaseId === 'string' ? purchaseId : null} />
    </div>
  </main>
}
