import type { Metadata } from 'next'
import CategoryRules from './workspace'

export const metadata: Metadata = { title: '가맹점 분류 규칙 | 개인 금융 관리' }

export default function CategoryRulesPage() {
  return <main className="recovery-shell">
    <header className="topbar"><a href="/finance-settings">계좌·카테고리 설정</a><span className="badge">Supabase 연결</span></header>
    <div className="content">
      <div className="section-heading recovery-heading"><h1>가맹점 분류 규칙</h1></div>
      <CategoryRules />
    </div>
  </main>
}
