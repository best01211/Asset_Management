import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { connectedNavigation, demoNavigation } from '@/lib/finance-navigation'
import { monthEnd } from '@/lib/home-dates'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { defaultRange } from '@/lib/transaction-history'
import TransactionsWorkspace from './workspace'
import SettingsWindow from '../settings-window'
import '../dashboard.css'
import './transactions.css'

export const metadata: Metadata = { title: '거래 | 개인 금융 관리' }

export default async function TransactionsPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; id?: string; mode?: string; month?: string; category?: string }>
}) {
  const query = await searchParams
  const demo = query.mode === 'demo' || (query.mode !== 'connected' && !await createClient())
  const range = isBudgetMonth(query.month)
    ? { from: query.month + '-01', to: monthEnd(query.month + '-01') } : defaultRange()
  const nav = demo ? demoNavigation : connectedNavigation
  return <div className="shell demo-dashboard transactions-shell">
    <aside className="sidebar">
      <Link className="brand" href={demo ? '/demo' : '/'}><span aria-hidden="true">₩</span><strong>자산 관리</strong></Link>
      <nav aria-label="메인 메뉴">{nav.map(([href, mark, label]) => href
        ? <Link key={label} href={href} aria-current={label === '거래' ? 'page' : undefined}><span aria-hidden="true">{mark}</span><span>{label}</span></Link>
        : <span key={label} className="demo-nav-disabled" aria-disabled="true"><span aria-hidden="true">{mark}</span><span>{label}</span></span>)}</nav>
    </aside>
    <main className="content">
      <header className="transactions-heading">
        <h1>거래</h1>
        <div className="transactions-heading-actions">{demo && <p>샘플 데이터</p>}<SettingsWindow demo={demo} /></div>
      </header>
      <TransactionsWorkspace demo={demo} explicitConnected={query.mode === 'connected'} tab={query.tab === 'review' ? 'review' : 'history'}
        reviewId={typeof query.id === 'string' ? query.id : undefined}
        range={range} category={typeof query.category === 'string' ? query.category : ''} />
    </main>
  </div>
}
