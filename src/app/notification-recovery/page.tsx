import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { purchaseOptions } from '@/lib/supabase/purchase-options'
import type { PurchaseOptions } from '@/lib/supabase/purchase-options'
import RecoveryWorkspace from './recovery-workspace'

export const metadata: Metadata = { title: '알림 복구 | 개인 금융 관리' }

async function connectedOptions(): Promise<PurchaseOptions | string> {
  const supabase = await createClient()
  if (!supabase) return 'Supabase 연결이 설정되지 않았습니다. 샘플로 복구 흐름을 확인할 수 있습니다.'

  const { data: session, error: authError } = await supabase.auth.getUser()
  if (authError || !session.user) return '연결된 알림을 보려면 인증된 사용자 세션이 필요합니다.'

  return (await purchaseOptions(supabase, session.user.id)) ?? '계좌와 카테고리를 불러오지 못했습니다. 페이지를 다시 열어 주세요.'
}

export default async function NotificationRecoveryPage({
  searchParams,
}: { searchParams: Promise<{ mode?: string | string[] }> }) {
  const connected = (await searchParams).mode === 'connected'
  const options = connected ? await connectedOptions() : { accounts: [], categories: [] }

  return (
    <main className="recovery-shell">
      <header className="topbar">
        <a href={connected ? '/transaction-review' : '/demo/transactions'}>{connected ? '연결된 거래 검토' : '거래 검토'}</a>
        <span className="badge">{connected ? 'Supabase 연결' : '샘플 데이터 · 이 브라우저에 저장'}</span>
      </header>
      <div className="content">
        <div className="section-heading recovery-heading">
          <div>
            <h1>알림 복구</h1>
            <p>처리하지 못한 결제 알림을 확인하고 대기 거래로 보냅니다.</p>
          </div>
          <a className="button outline" href={connected ? '/notification-recovery' : '/notification-recovery?mode=connected'}>
            {connected ? '샘플 보기' : '연결된 알림 보기'}
          </a>
        </div>
        {typeof options === 'string'
          ? <section className="panel" aria-label="연결 상태"><p>{options}</p></section>
          : <RecoveryWorkspace connected={connected} initialAccounts={options.accounts} initialCategories={options.categories} />}
      </div>
    </main>
  )
}
