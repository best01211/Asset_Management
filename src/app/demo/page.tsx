import type { Metadata } from 'next'
import Dashboard from '../dashboard'

export const metadata: Metadata = { title: '샘플 대시보드 | 개인 금융 관리' }

export default function DemoPage() {
  return <Dashboard />
}
