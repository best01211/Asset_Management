'use client'

import { useEffect, useState } from 'react'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'
import type { DuplicateAction, ReviewTransaction } from '@/lib/transaction-review'

type Candidate = Pick<ReviewTransaction, 'id' | 'merchant' | 'amount_minor' | 'currency' | 'occurred_at' | 'status'>
type Comparison = { linked_id: string | null; candidates: Candidate[] }

export default function DuplicateReview({ row, saving, onSavingChange, onCancel, onFinished }: {
  row: ReviewTransaction
  saving: boolean
  onSavingChange: (saving: boolean) => void
  onCancel: () => void
  onFinished: (message: string) => void
}) {
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [referenceId, setReferenceId] = useState('')
  const [message, setMessage] = useState('')
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const url = '/api/pending-transactions/' + encodeURIComponent(row.id) + '/duplicates'

  useEffect(() => {
    const controller = new AbortController()
    fetch(url, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error()
      const data: Comparison = await response.json()
      setComparison(data)
      setReferenceId(data.linked_id ?? '')
    }).catch(() => {
      if (!controller.signal.aborted) setMessage('비교할 거래를 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [url])

  async function decide(action: DuplicateAction) {
    if (saving) return
    onSavingChange(true)
    setMessage('')
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_version: row.version, action, ...(action === 'flag' ? { reference_id: referenceId } : {}),
        }),
      })
      if (response.status === 404 || response.status === 409) {
        onFinished('거래 상태가 변경되었습니다. 최신 목록을 다시 불러옵니다.')
      } else if (response.status === 422) {
        setMessage('비교할 거래가 변경되었거나 선택할 수 없습니다. 비교 화면을 다시 열어 주세요.')
      } else if (!response.ok) {
        setMessage('중복 검토 결과를 저장하지 못했습니다.')
      } else {
        onFinished({
          flag: '거래를 중복 의심으로 표시했습니다.',
          keep: '거래를 검토 대기로 돌렸습니다.',
          dismiss: '중복 거래를 제외했습니다. 확정 원장에는 반영되지 않습니다.',
        }[action])
      }
    } catch {
      setMessage('중복 검토 결과를 확인하지 못했습니다.')
    } finally {
      onSavingChange(false)
    }
  }

  const amount = (candidate: Candidate) => candidate.currency === 'KRW'
    ? formatWon(candidate.amount_minor) : candidate.amount_minor + ' (' + candidate.currency + ')'
  return (
    <>
      <p className="recovery-message"><strong>{row.merchant}</strong> · {amount(row)} · {formatSeoulTime(row.occurred_at)}</p>
      {!comparison && !message && <p role="status">비교할 거래를 불러오는 중입니다.</p>}
      {comparison && <>
        <fieldset className="duplicate-choices" disabled={saving || confirmDismiss}>
          <legend>비교 대상</legend>
          {comparison.candidates.length === 0 && <p>같은 금액의 비교 후보가 없습니다.</p>}
          {comparison.candidates.map((candidate) => (
            <label key={candidate.id}>
              <input type="radio" name="reference" checked={referenceId === candidate.id}
                disabled={!['pending_review', 'confirmed'].includes(candidate.status)}
                onChange={() => setReferenceId(candidate.id)} />
              <span>{candidate.merchant} · {amount(candidate)}<small>{formatSeoulTime(candidate.occurred_at)}
                {candidate.status === 'confirmed' ? ' · 확정' : ' · 검토 대기'}</small></span>
            </label>
          ))}
        </fieldset>
        {row.status === 'duplicate_suspected' && confirmDismiss ? (
          <div className="row-actions">
            <button type="button" disabled={saving} onClick={() => decide('dismiss')}>중복 제외 확정</button>
            <button type="button" className="outline" disabled={saving} onClick={() => setConfirmDismiss(false)}>취소</button>
          </div>
        ) : (
          <div className="review-filters">
            <button type="button" disabled={saving || !referenceId || referenceId === comparison.linked_id}
              onClick={() => decide('flag')}>{row.status === 'pending_review' ? '중복 의심으로 표시' : '비교 대상 변경'}</button>
            {row.status === 'duplicate_suspected' && <>
              <button type="button" className="outline" disabled={saving} onClick={() => decide('keep')}>정상 거래로 돌리기</button>
              <button type="button" className="outline" disabled={saving || !comparison.linked_id || referenceId !== comparison.linked_id}
                onClick={() => setConfirmDismiss(true)}>중복으로 제외</button>
            </>}
          </div>
        )}
      </>}
      <p className="recovery-message" role="status">{message}</p>
      <button type="button" className="outline" disabled={saving} onClick={onCancel}>비교 닫기</button>
    </>
  )
}
