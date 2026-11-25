import type { Metadata } from 'next'
import Dashboard from '../../dashboard'

export const metadata: Metadata = { title: '샘플 계좌·카드 설정 | 개인 금융 관리' }

export default function DemoAccountsPage() {
  return <Dashboard page="accounts" />
}
