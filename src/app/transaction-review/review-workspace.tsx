'use client'

import { useEffect, useRef, useState } from 'react'
import { approvalBatchLimit, paymentLabels, reviewStatuses } from '@/lib/transaction-review'
import type { ReviewCursor, ReviewPage, ReviewStatus, ReviewTransaction } from '@/lib/transaction-review'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'
import PendingEditForm from './pending-edit-form'
import DuplicateReview from './duplicate-review'
import SplitEditor from './split-editor'
import { canLeaveDraft } from '../transactions/draft'

const labels: Record<ReviewStatus, string> = {
  pending_review: '검토 대기',
  duplicate_suspected: '중복 의심',
  confirmed: '확정',
  dismissed: '제외',
}

function formatAmount(row: ReviewTransaction) {
  return row.currency === 'KRW' ? formatWon(row.amount_minor) : row.amount_minor + ' (' + row.currency + ')'
}

async function fetchPage(status: ReviewStatus, cursor: ReviewCursor | null, search = '', signal?: AbortSignal, id?: string): Promise<ReviewPage> {
  const query = new URLSearchParams({ status, ...cursor })
  if (search) query.set('q', search)
  if (id) query.set('id', id)
  const response = await fetch('/api/pending-transactions?' + query, { signal, cache: 'no-store' })
  if (response.status === 401) throw new Error('연결된 거래를 보려면 인증된 사용자 세션이 필요합니다.')
  if (response.status === 503) throw new Error('Supabase 연결이 설정되지 않았습니다.')
  if (!response.ok) throw new Error('거래 목록을 불러오지 못했습니다.')
  return response.json()
}

type ApprovalBody = { status?: string; transaction_id?: string; ledger_posted?: boolean }
type ApprovalResult = { id: string; status: number; body: ApprovalBody | null }
type BatchLine = { id: string; merchant: string; approved: boolean; message: string }

function approvalConfirmed(body: ApprovalBody | null) {
  return body?.status === 'confirmed' && Boolean(body.transaction_id) && body.ledger_posted === true
}

function batchFailure(status: number) {
  if (status === 409) return '거래 상태 또는 버전이 변경됨'
  if (status === 404) return '거래를 찾을 수 없음'
  if (status === 422) return '계좌·카테고리 확인 필요'
  return '승인 결과를 확인하지 못함'
}

export default function ReviewWorkspace({ initialId, openOnly = false, onChanged }: {
  initialId?: string; openOnly?: boolean; onChanged?: () => void
}) {
  const [status, setStatus] = useState<ReviewStatus>('pending_review')
  const [rows, setRows] = useState<ReviewTransaction[]>([])
  const [cursor, setCursor] = useState<ReviewCursor | null>(null)
  const [selected, setSelected] = useState<ReviewTransaction | null>(null)
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editingBusy, setEditingBusy] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [markedIds, setMarkedIds] = useState<string[]>([])
  const [reviewingBatch, setReviewingBatch] = useState(false)
  const [batchResults, setBatchResults] = useState<BatchLine[]>([])
  const [revision, setRevision] = useState(0)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const requestKeys = useRef(new Map<string, string>())
  const busy = approving || editingBusy
  const canReview = status === 'pending_review' || status === 'duplicate_suspected'
  const marked = rows.filter((row) => markedIds.includes(row.id))

  useEffect(() => {
    const controller = new AbortController()
    fetchPage(status, null, search, controller.signal).then((page) => {
      setRows(page.transactions)
      setCursor(page.next_cursor)
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setListError(error.message)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [status, revision, search])

  useEffect(() => {
    if (!initialId) return
    const controller = new AbortController()
    fetchPage('pending_review', null, '', controller.signal, initialId).then((page) => {
      if (controller.signal.aborted) return
      const row = page.transactions[0]
      if (!row || (row.status !== 'pending_review' && row.status !== 'duplicate_suspected')) {
        setNotice('해당 거래의 검토가 이미 끝났거나 거래를 찾을 수 없습니다.')
        return
      }
      if (row.status !== 'pending_review') {
        setStatus(row.status)
        setRows([])
        setCursor(null)
        setLoading(true)
      }
      setSelected(row)
      setComparing(row.status === 'duplicate_suspected')
    }).catch(() => {
      if (!controller.signal.aborted) setNotice('지정한 대기 거래를 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [initialId])

  function resetList() {
    setLoading(true)
    setRows([])
    setCursor(null)
    setSelected(null)
    setEditing(false)
    setComparing(false)
    setSplitting(false)
    setMarkedIds([])
    setReviewingBatch(false)
    setListError('')
  }

  function refresh() {
    resetList()
    setRevision((value) => value + 1)
    onChanged?.()
  }

  async function loadMore(next: ReviewCursor) {
    setLoading(true)
    setListError('')
    try {
      const page = await fetchPage(status, next, search)
      setRows((current) => [...current, ...page.transactions.filter((row) => !current.some((item) => item.id === row.id))])
      setCursor(page.next_cursor)
    } catch (error) {
      setListError(error instanceof Error ? error.message : '거래 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  function approvalInput(row: ReviewTransaction) {
    const storageKey = 'asset-management:approval:' + row.id + ':' + row.version
    let key = requestKeys.current.get(storageKey)
    try {
      key ??= sessionStorage.getItem(storageKey) ?? undefined
    } catch {
      // The in-memory key supports retries when tab storage is unavailable.
    }
    key ??= crypto.randomUUID()
    requestKeys.current.set(storageKey, key)
    try {
      sessionStorage.setItem(storageKey, key)
    } catch {
      // Tab storage is optional.
    }
    return { id: row.id, expected_version: row.version, idempotency_key: key }
  }

  function clearRequestKey(row: ReviewTransaction) {
    const storageKey = 'asset-management:approval:' + row.id + ':' + row.version
    requestKeys.current.delete(storageKey)
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      // Tab storage is optional.
    }
  }

  async function approve(row: ReviewTransaction) {
    if (busy || row.status !== 'pending_review') return
    setApproving(true)
    setNotice('')
    setBatchResults([])
    try {
      const { expected_version, idempotency_key } = approvalInput(row)
      const response = await fetch('/api/pending-transactions/' + encodeURIComponent(row.id) + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_version, idempotency_key }),
      })
      if (response.status === 409 || response.status === 404) {
        clearRequestKey(row)
        setNotice('거래 상태가 변경되었습니다. 최신 목록을 다시 불러옵니다.')
        refresh()
        return
      }
      if (response.status === 401) throw new Error('인증 세션을 확인할 수 없습니다.')
      if (response.status === 422) throw new Error('결제 계좌와 카테고리를 확인해 주세요.')
      if (!response.ok) throw new Error('승인 결과를 확인하지 못했습니다. 다시 시도해 주세요.')

      const result = await response.json()
      if (!approvalConfirmed(result)) {
        throw new Error('승인 결과를 확인하지 못했습니다. 다시 시도해 주세요.')
      }
      clearRequestKey(row)
      setNotice(row.merchant + ' 거래를 확정했습니다.')
      refresh()
    } catch (error) {
      setNotice(error instanceof Error && !(error instanceof TypeError)
        ? error.message : '승인 결과를 확인하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setApproving(false)
    }
  }

  async function approveBatch() {
    if (busy || !marked.length) return
    setApproving(true)
    setNotice('')
    setBatchResults([])
    try {
      const response = await fetch('/api/pending-transactions/batch-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: marked.map(approvalInput) }),
      })
      if (response.status === 401) {
        setNotice('인증 세션을 확인할 수 없습니다.')
        return
      }
      if (!response.ok) throw new Error()
      const { results }: { results: ApprovalResult[] } = await response.json()
      if (!Array.isArray(results) || results.length !== marked.length
        || results.some((result, index) => result.id !== marked[index].id)) throw new Error()
      const lines = results.map((result, index): BatchLine => {
        const row = marked[index]
        const approved = result.status === 200 && approvalConfirmed(result.body)
        if (approved || [404, 409, 422].includes(result.status)) clearRequestKey(row)
        return { id: row.id, merchant: row.merchant, approved, message: approved ? '확정' : batchFailure(result.status) }
      })
      const approvedCount = lines.filter((item) => item.approved).length
      setBatchResults(lines)
      setNotice('확정 ' + approvedCount + '건 · 확인 필요 ' + (lines.length - approvedCount) + '건')
      refresh()
    } catch {
      setNotice('일괄 승인 결과를 확인하지 못했습니다. 같은 선택으로 다시 시도할 수 있습니다.')
    } finally {
      setApproving(false)
    }
  }

  return (
    <div className="connected-review">
      <section className="panel" aria-labelledby="review-list-title" aria-busy={loading}>
        <div className="section-heading">
          <h2 id="review-list-title">거래 목록</h2>
          <div className="row-actions">
            {status === 'pending_review' && !listError && <button type="button" disabled={loading || busy} onClick={() => {
              if (!canLeaveDraft()) return
              setSelected(null)
              setEditing(true)
              setComparing(false)
              setSplitting(false)
              setReviewingBatch(false)
              setBatchResults([])
              setNotice('')
            }}>구매 입력</button>}
            <button type="button" className="outline" disabled={loading || busy} onClick={() => {
            if (!canLeaveDraft()) return
            setNotice('')
            setBatchResults([])
            refresh()
            }}>새로고침</button>
          </div>
        </div>
        <div className="review-filters" role="group" aria-label="거래 상태">
          {reviewStatuses.filter((value) => !openOnly || value !== 'confirmed').map((value) => (
            <button key={value} type="button" className={status === value ? '' : 'outline'}
              aria-pressed={status === value} disabled={busy || loading} onClick={() => {
                if (value === status || !canLeaveDraft()) return
                setNotice('')
                setBatchResults([])
                resetList()
                setStatus(value)
              }}>{labels[value]}</button>
          ))}
        </div>
        {openOnly && <form className="review-search" onSubmit={(event) => {
          event.preventDefault()
          const value = String(new FormData(event.currentTarget).get('q') ?? '').trim()
          if (value === search || !canLeaveDraft()) return
          resetList()
          setSearch(value)
        }}>
          <label>가맹점 검색<input name="q" type="search" maxLength={200} disabled={busy} /></label>
          <button type="submit" className="outline" disabled={busy}>검색</button>
        </form>}
        {status === 'pending_review' && rows.length > 0 && <div className="review-filters">
          <button type="button" className="outline" disabled={loading || busy || !marked.length} onClick={() => {
            if (!canLeaveDraft()) return
            setSelected(null)
            setEditing(false)
            setComparing(false)
            setSplitting(false)
            setReviewingBatch(true)
            setBatchResults([])
            setNotice('')
          }}>선택 승인 ({marked.length})</button>
          {marked.length === approvalBatchLimit && <small>한 번에 최대 {approvalBatchLimit}건을 승인할 수 있습니다.</small>}
        </div>}
        {listError && <p className="recovery-message" role="alert">{listError}</p>}
        {loading && !rows.length && <p className="recovery-message" role="status">거래를 불러오는 중입니다.</p>}
        {!loading && !listError && !rows.length && <p className="recovery-message">{labels[status]} 거래가 없습니다.</p>}
        {rows.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr>{status === 'pending_review' && <th scope="col">선택</th>}
                <th scope="col">가맹점</th><th scope="col">거래 시각</th><th scope="col">계좌 · 분류</th>
                <th scope="col" className="numeric">금액</th>{(canReview || status === 'confirmed') && <th scope="col">작업</th>}</tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={row.id} data-selected={selected?.id === row.id}>
                  {status === 'pending_review' && <td><input type="checkbox" aria-label={row.merchant + ' 선택'}
                    disabled={busy || loading || (marked.length === approvalBatchLimit && !markedIds.includes(row.id))}
                    checked={markedIds.includes(row.id)} onChange={(event) => {
                      const checked = event.target.checked
                      setMarkedIds((current) => checked ? [...current, row.id] : current.filter((id) => id !== row.id))
                    }} /></td>}
                  <th scope="row">{row.merchant}</th>
                  <td>{formatSeoulTime(row.occurred_at)}</td>
                  <td>{row.account?.name ?? '계좌'} · {row.allocations?.length
                    ? '분할 ' + row.allocations.length + '개' : row.category?.name ?? '미분류'}</td>
                  <td className="numeric">{formatAmount(row)}</td>
                  {canReview && <td><button type="button" className="outline"
                    aria-label={row.merchant + ' 검토'} disabled={busy || loading}
                    onClick={() => {
                      if (!canLeaveDraft()) return
                      setSelected(row)
                      setEditing(false)
                      setComparing(status === 'duplicate_suspected')
                      setSplitting(false)
                      setReviewingBatch(false)
                      setBatchResults([])
                      setNotice('')
                    }}>검토</button></td>}
                  {status === 'confirmed' && <td>{row.confirmed_transaction_id && row.currency === 'KRW' &&
                    <div className="row-actions">
                      <a href={'/account-activity?purchase_id=' + encodeURIComponent(row.confirmed_transaction_id)}>환불·정정</a>
                      {row.payment_method === 'credit_card' && <a href={'/card-installments?purchase_id='
                        + encodeURIComponent(row.confirmed_transaction_id)}>할부 계획</a>}
                    </div>}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {cursor && <button type="button" className="outline review-more" disabled={loading || busy} onClick={() => loadMore(cursor)}>
          {loading ? '불러오는 중' : '거래 더 보기'}
        </button>}
        {status === 'duplicate_suspected' && rows.length > 0 && <p className="recovery-message">중복 의심 거래는 검토 대기 상태가 된 후 승인할 수 있습니다.</p>}
      </section>
      <section className="panel" aria-labelledby="review-detail-title">
        <h2 id="review-detail-title">{splitting ? '카테고리 분할' : comparing ? '중복 거래 비교' : editing ? (selected ? '대기 거래 수정' : '새 구매 거래') : '승인 확인'}</h2>
        {selected && splitting ? <SplitEditor key={selected.id + ':' + selected.version} transaction={selected}
          saving={editingBusy} onSavingChange={setEditingBusy} onCancel={() => setSplitting(false)}
          onFinished={(message) => { setNotice(message); refresh() }} />
          : selected && comparing ? <DuplicateReview key={selected.id + ':' + selected.version} row={selected}
          saving={editingBusy} onSavingChange={setEditingBusy}
          onCancel={() => { setComparing(false); if (selected.status !== 'pending_review') setSelected(null) }}
          onFinished={(message) => { setNotice(message); refresh() }} />
          : editing ? <PendingEditForm key={selected ? selected.id + ':' + selected.version : 'new'} row={selected ?? undefined}
          saving={editingBusy} onSavingChange={setEditingBusy} onCancel={() => { if (canLeaveDraft()) setEditing(false) }}
          onFinished={(message) => { setNotice(message); refresh() }} />
          : selected ? (
          <>
            <dl className="review-detail">
              <dt>가맹점</dt><dd>{selected.merchant}</dd>
              <dt>금액</dt><dd>{formatAmount(selected)}</dd>
              <dt>결제 수단</dt><dd>{paymentLabels[selected.payment_method]}</dd>
              <dt>계좌</dt><dd>{selected.account?.name ?? '계좌'}</dd>
              <dt>카테고리</dt><dd>{selected.allocations?.length
                ? '분할 ' + selected.allocations.length + '개' : selected.category?.name ?? '미분류'}</dd>
            </dl>
            <div className="row-actions">
              <button type="button" disabled={busy || loading} onClick={() => approve(selected)}>
                {approving ? '승인 중' : '확정 승인'}
              </button>
              {selected.currency === 'KRW' && <button type="button" className="outline" disabled={busy || loading}
                onClick={() => { setEditing(true); setNotice('') }}>수정</button>}
              {selected.currency === 'KRW' && <button type="button" className="outline" disabled={busy || loading}
                onClick={() => { setSplitting(true); setNotice('') }}>분할</button>}
              <button type="button" className="outline" disabled={busy || loading}
                onClick={() => { setComparing(true); setNotice('') }}>중복 비교</button>
              <button type="button" className="outline" disabled={busy} onClick={() => { setSelected(null); setNotice('') }}>닫기</button>
            </div>
          </>
        ) : reviewingBatch ? (
          <>
            <p className="recovery-message">선택한 {marked.length}건을 각각 확정합니다.</p>
            <ul className="review-batch-list">{marked.map((row) => <li key={row.id}>{row.merchant} · {formatAmount(row)}</li>)}</ul>
            <div className="row-actions">
              <button type="button" disabled={busy || loading || !marked.length} onClick={approveBatch}>
                {approving ? '승인 중' : '일괄 확정 승인'}
              </button>
              <button type="button" className="outline" disabled={busy} onClick={() => setReviewingBatch(false)}>취소</button>
            </div>
          </>
        ) : !batchResults.length && <p className="recovery-message">검토 대기 거래를 선택해 승인할 수 있습니다.</p>}
        <p className="recovery-message" role="status">{notice}</p>
        {batchResults.length > 0 && <ul className="review-batch-list" aria-label="일괄 승인 결과">
          {batchResults.map((line) => <li key={line.id}>
            <strong>{line.merchant}</strong> · <span className={line.approved ? '' : 'batch-warning'}>{line.message}</span>
          </li>)}
        </ul>}
      </section>
    </div>
  )
}
