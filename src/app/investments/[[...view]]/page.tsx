import '../../dashboard.css'
import '../investments.css'
import Workspace from '../workspace'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connectedNavigation, demoNavigation } from '@/lib/finance-navigation'

export const metadata = { title: '투자·외화 | 개인 금융 관리' }
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ view?: string[] }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { view = [] } = await params,
    query = await searchParams
  if (
    view.length &&
    !(view.length === 1 && view[0] === 'history') &&
    !(view.length === 2 && view[0] === 'asset')
  )
    notFound()
  const demo =
    query.mode === 'demo' ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  let asset = ''
  try {
    asset = decodeURIComponent(view[1] || '')
  } catch {
    notFound()
  }
  return (
    <div className="shell demo-dashboard iv-shell">
      <aside className="sidebar">
        <Link className="brand" href={demo ? '/demo' : '/'}>
          <span>₩</span>
          <strong>자산 관리</strong>
        </Link>
        <nav aria-label="메인 메뉴">
          {(demo ? demoNavigation : connectedNavigation).map(
            ([href, mark, label]) =>
              href && (
                <Link key={href} href={href} aria-current={label === '투자·외화' ? 'page' : undefined}>
                  <span aria-hidden="true">{mark}</span>
                  <span>{label}</span>
                </Link>
              ),
          )}
        </nav>
      </aside>
      <main className="content">
        <Workspace key={demo ? 'demo' : 'connected'} demo={demo} view={view[0] || 'home'} asset={asset} />
      </main>
    </div>
  )
}
