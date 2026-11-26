import type { Metadata } from 'next'
import Link from 'next/link'
import { connectedNavigation } from '@/lib/finance-navigation'
import { today } from '@/lib/local-finance'
import { isBudgetMonth } from '@/lib/monthly-budget'
import BudgetWorkspace from './workspace'
import '../dashboard.css'
import './budgets.css'

export const metadata: Metadata = { title: '월별 예산 | 개인 금융 관리' }

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const query = await searchParams
  const month = isBudgetMonth(query.month) ? query.month : today().slice(0, 7)
  return <div className="shell demo-dashboard budget-shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span aria-hidden="true">₩</span><strong>자산 관리</strong></Link>
      <nav aria-label="메인 메뉴">{connectedNavigation.map(([href, mark, label]) => <Link key={href} href={href} aria-current={href === '/budgets' ? 'page' : undefined}>
        <span aria-hidden="true">{mark}</span><span>{label}</span></Link>)}</nav>
    </aside>
    <main className="content"><BudgetWorkspace key={month} month={month} /></main>
  </div>
}
