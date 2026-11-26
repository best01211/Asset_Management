import type { Metadata } from 'next'
import Link from 'next/link'
import { connectedNavigation } from '@/lib/finance-navigation'
import { today } from '@/lib/local-finance'
import { isBudgetMonth } from '@/lib/monthly-budget'
import Workspace from './workspace'
import '../dashboard.css'
import './recurring.css'

export const metadata: Metadata = { title: '정기 결제 | 개인 금융 관리' }

export default async function RecurringPage({ searchParams }: {
  searchParams: Promise<{ month?: string; id?: string; occurrence?: string }>
}) {
  const query = await searchParams
  const month = isBudgetMonth(query.month) && query.month <= '9997-12' ? query.month : today().slice(0, 7)
  const service = typeof query.id === 'string' ? query.id : ''
  const occurrence = typeof query.occurrence === 'string' ? query.occurrence : ''
  return <div className="shell demo-dashboard recurring-shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span aria-hidden="true">₩</span><strong>자산 관리</strong></Link>
      <nav aria-label="메인 메뉴">{connectedNavigation.map(([href, mark, label]) =>
        <Link key={href} href={href} aria-current={href === '/recurring-payments' ? 'page' : undefined}>
          <span aria-hidden="true">{mark}</span><span>{label}</span>
        </Link>)}</nav>
    </aside>
    <main className="content"><Workspace key={month + '/' + service + '/' + occurrence} month={month}
      initialService={service} initialOccurrence={occurrence} /></main>
  </div>
}
