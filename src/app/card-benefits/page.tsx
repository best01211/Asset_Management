import type { Metadata } from 'next'
import Link from 'next/link'
import { formatWon } from '@/lib/format-finance'
import { purchaseOptions } from '@/lib/supabase/purchase-options'
import { createClient } from '@/lib/supabase/server'
import BenefitForms from './benefit-forms'

export const metadata: Metadata = { title: '카드 혜택 | 개인 금융 관리' }
export const dynamic = 'force-dynamic'

type Terms = {
  card_id: string
  card: { name: string } | null
  version: number
  effective_from: string
  effective_until: string | null
  source: string
  category_id: string | null
  rate_bps: number
  prior_spend_minor: string
  monthly_cap_minor: string | null
}

async function loadTerms() {
  const supabase = await createClient()
  if (!supabase) return { error: 'Supabase 연결이 설정되지 않았습니다.' }
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { error: '인증된 사용자 세션이 필요합니다.' }
  const [options, versions] = await Promise.all([
    purchaseOptions(supabase, user.id),
    supabase.from('card_benefit_terms')
      .select('card_id,version,effective_from,effective_until,source,category_id,rate_bps,prior_spend_minor::text,monthly_cap_minor::text,card:financial_accounts!card_benefit_terms_user_id_card_id_fkey(name)')
      .eq('user_id', user.id).order('created_at', { ascending: false }).order('card_id')
      .order('version', { ascending: false }).limit(50).overrideTypes<Terms[], { merge: false }>(),
  ])
  if (!options || versions.error) return { error: '카드 약관과 계좌를 불러오지 못했습니다.' }
  return { cards: options.accounts.filter((account) => account.kind === 'liability'), categories: options.categories, versions: versions.data }
}

export default async function CardBenefitsPage() {
  const result = await loadTerms()
  const today = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date())
  return <main className="recovery-shell">
    <header className="topbar"><div className="row-actions">
      <Link href="/">금융 현황</Link><a href="/finance-settings">계좌·카테고리 설정</a><a href="/card-installments">카드 할부 계획</a>
    </div></header>
    <div className="content">
      <div className="section-heading recovery-heading"><h1>카드 혜택</h1></div>
      {result.error ? <section className="panel"><p role="status">{result.error}</p></section> : <>
        <BenefitForms cards={result.cards ?? []} categories={result.categories ?? []} today={today} />
        <section className="panel" aria-labelledby="benefit-history">
          <h2 id="benefit-history">최근 저장한 약관 버전</h2>
          {result.versions?.length ? <div className="table-scroll"><table>
            <thead><tr>
              <th scope="col">카드</th><th scope="col">적용 기간</th><th scope="col">카테고리</th>
              <th scope="col">혜택률</th><th scope="col">전월 최소 실적</th><th scope="col">월 혜택 한도</th><th scope="col">출처</th>
            </tr></thead>
            <tbody>{result.versions.map((item) => <tr key={item.card_id + ':' + item.version}>
              <th scope="row">{item.card?.name ?? '카드 계좌'}<br /><small>버전 {item.version}</small></th>
              <td>{item.effective_from} ~ {item.effective_until ?? ''}</td>
              <td>{item.category_id ? result.categories?.find((category) => category.id === item.category_id)?.name ?? '카테고리 확인 필요' : '제한 없음'}</td>
              <td className="numeric">{item.rate_bps / 100}%</td>
              <td className="numeric">{formatWon(item.prior_spend_minor)}</td>
              <td className="numeric">{item.monthly_cap_minor === null ? '제한 없음' : formatWon(item.monthly_cap_minor)}</td>
              <td>{item.source}</td>
            </tr>)}</tbody>
          </table></div> : <p>저장된 약관이 없습니다.</p>}
        </section>
      </>}
    </div>
  </main>
}
