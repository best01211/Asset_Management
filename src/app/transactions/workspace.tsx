'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import Dashboard from '../dashboard'
import ReviewWorkspace from '../transaction-review/review-workspace'
import HistoryWorkspace from './history-workspace'
import { readDemoFinance } from '@/lib/local-finance'

import { canLeaveDraft } from './draft'

export default function TransactionsWorkspace({ demo, explicitConnected, tab, reviewId, range, category }: {
  demo: boolean; explicitConnected: boolean; tab: 'history' | 'review'; reviewId?: string; range: { from: string; to: string }; category: string
}) {
  const [queue, setQueue] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const refreshBadge = useCallback(() => setRevision((value) => value + 1), [])
  const mode = demo ? 'demo' : explicitConnected ? 'connected' : null
  const historyHref = '/transactions' + (mode ? '?mode=' + mode : '')
  const reviewHref = '/transactions?tab=review' + (mode ? '&mode=' + mode : '')
  useEffect(() => {
    const controller = new AbortController()
    function demoCount() {
      try { setQueue(readDemoFinance(localStorage).purchases.filter((purchase) => purchase.status === 'pending').length) }
      catch { setQueue(null) }
    }
    if (demo) {
      queueMicrotask(() => { if (!controller.signal.aborted) demoCount() })
      window.addEventListener('finance:demo-change', demoCount)
      window.addEventListener('storage', demoCount)
      return () => {
        controller.abort()
        window.removeEventListener('finance:demo-change', demoCount)
        window.removeEventListener('storage', demoCount)
      }
    }
    fetch('/api/pending-transactions?count=review', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json()).count as number : null)
      .then((count) => { if (!controller.signal.aborted) setQueue(count) })
      .catch(() => { if (!controller.signal.aborted) setQueue(null) })
    return () => controller.abort()
  }, [demo, revision])

  const tabs = <nav className="transaction-tabs" aria-label="거래 페이지">
      <Link href={historyHref} data-draft-guard="true" aria-current={tab === 'history' ? 'page' : undefined}
        onNavigate={(event) => { if (!canLeaveDraft()) event.preventDefault() }}>거래 내역</Link>
      <Link href={reviewHref} data-draft-guard="true" aria-current={tab === 'review' ? 'page' : undefined}
        onNavigate={(event) => { if (!canLeaveDraft()) event.preventDefault() }}>거래 검토{queue !== null && <span className="queue-badge">{queue}</span>}</Link>
    </nav>
  if (tab === 'history') return <HistoryWorkspace key={range.from + range.to + category + demo} demo={demo} range={range} category={category} tabs={tabs} />
  return <>
    {tabs}
    {demo ? <Dashboard key={reviewId} page="transactions" embedded initialReviewId={reviewId} /> : <>
        <div className="transaction-review-links">
          <Link href="/notification-recovery?mode=connected">알림 복구</Link>
          <Link href="/ledger-summary">확정 원장 집계</Link>
        </div>
        <ReviewWorkspace key={reviewId} initialId={reviewId} onChanged={refreshBadge} openOnly />
      </>}
  </>
}
