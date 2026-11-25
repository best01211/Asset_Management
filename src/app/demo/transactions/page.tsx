import type { Metadata } from 'next'
import Dashboard from '../../dashboard'
import { isBudgetMonth } from '@/lib/monthly-budget'

export const metadata: Metadata = { title: '샘플 거래 검토 | 개인 금융 관리' }

export default async function DemoTransactionsPage({ searchParams }: { searchParams: Promise<{ category?: string; month?: string }> }) {
  const { category, month } = await searchParams
  return <Dashboard page="transactions" initialCategory={typeof category === 'string' ? category : ''} initialMonth={isBudgetMonth(month) ? month : ''} />
}
