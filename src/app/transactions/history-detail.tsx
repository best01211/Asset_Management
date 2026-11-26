'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { formatSeoulTime } from '@/lib/format-finance'
import { readDemoFinance, storageKey } from '@/lib/local-finance'
import { formatMinor, isPurchase, kindLabels } from '@/lib/transaction-history'
import type { Annotation, HistoryDetails, HistoryRow } from '@/lib/transaction-history'
import { canLeaveDraft, useUnsavedDraft } from './draft'
import CategoryMoveForm from './category-move-form'

const auditLabels: Record<string, string> = {
  transaction_annotation_saved: '메모·태그 저장',
  transaction_category_changed: '카테고리 이동',
  transaction_tags_updated: '연결된 태그 변경',
  purchase_refund: '환불 기록',
  purchase_reversal: '정정 기록',
  approved: '승인', approve: '승인', confirmed: '확정',
}
const displayDate = (date: string) => date.length === 10 ? date : formatSeoulTime(date)

export default function HistoryDetail({ row, annotation, annotations, revision, demo, onSave, onCategoryChange, onClose }: {
  row: HistoryRow; annotation?: Annotation; annotations: boolean; revision: number; demo: boolean
  onSave: (annotation: Annotation) => void; onCategoryChange: () => void; onClose: () => void
}) {
  const [detail, setDetail] = useState<HistoryDetails | null>(null)
  const [detailError, setDetailError] = useState(false)
  const [receipts, setReceipts] = useState<string[] | null>(null)
  const [receiptFailed, setReceiptFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [tagOptions, setTagOptions] = useState<string[]>([])
  const [memo, setMemo] = useState(annotation?.memo ?? '')
  const [tags, setTags] = useState(annotation?.tags.join(', ') ?? '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const dirty = editing && (memo !== (annotation?.memo ?? '') || tags !== (annotation?.tags.join(', ') ?? ''))
  useUnsavedDraft(dirty)

  useEffect(() => {
    if (demo || !editing) return
    const controller = new AbortController()
    fetch('/api/categories?tags=1', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json()).tags as { name: string }[] : [])
      .then((items) => { if (!controller.signal.aborted) setTagOptions(items.map((item) => item.name)) })
      .catch(() => { if (!controller.signal.aborted) setTagOptions([]) })
    return () => controller.abort()
  }, [demo, editing])

  useEffect(() => {
    if (demo) return
    const controller = new AbortController()
    fetch('/api/transactions/' + encodeURIComponent(row.id), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() })
      .then((data) => { if (!controller.signal.aborted) setDetail(data) })
      .catch(() => { if (!controller.signal.aborted) setDetailError(true) })
    return () => controller.abort()
  }, [demo, row.id, revision])

  const attachmentEndpoint = row.pendingId ? '/api/pending-transactions/' + encodeURIComponent(row.pendingId) + '/attachments' : ''
  async function loadReceipts() {
    if (!attachmentEndpoint) return
    setReceiptFailed(false)
    try {
      const response = await fetch(attachmentEndpoint, { cache: 'no-store' })
      if (!response.ok) throw new Error()
      const { files }: { files: { name: string }[] } = await response.json()
      setReceipts(files.map((file) => file.name))
    } catch { setReceiptFailed(true) }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const parsedTags = [...new Set(tags.split(',').map((item) => item.trim()).filter(Boolean))]
    if (parsedTags.length > 10 || parsedTags.some((tag) => [...tag].length > 24)) {
      setMessage('태그는 한 개당 24자, 최대 10개를 사용할 수 있습니다.')
      return
    }
    setSaving(true)
    setMessage('')
    try {
      const version = annotation?.version ?? 0
      let saved: Annotation
      if (demo) {
        const local = readDemoFinance(localStorage)
        if ((local.annotations?.[row.id]?.version ?? 0) !== version) {
          setMessage('메모가 다른 탭에서 변경되었습니다. 작성 내용을 복사한 뒤 다시 열어 주세요.')
          return
        }
        saved = { memo, tags: parsedTags, version: version + 1 }
        localStorage.setItem(storageKey, JSON.stringify({ ...local, annotations: { ...local.annotations, [row.id]: saved } }))
      } else {
        const response = await fetch('/api/transactions/' + encodeURIComponent(row.id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memo, tags: parsedTags, version }),
        })
        if (response.status === 409) {
          setMessage('다른 화면에서 메모가 변경되었습니다. 작성 내용을 복사한 뒤 다시 열어 주세요.')
          return
        }
        if (!response.ok) throw new Error()
        saved = await response.json()
      }
      onSave(saved)
      setEditing(false)
      setMessage('메모와 태그를 저장했습니다.')
    } catch {
      setMessage('메모와 태그를 저장하지 못했습니다.')
    } finally { setSaving(false) }
  }

  return <section className="panel transaction-detail" aria-labelledby="transaction-detail-title" data-unsaved={dirty} data-saving={saving}>
    <div className="transaction-list-heading">
      <h2 id="transaction-detail-title">거래 상세</h2>
      <button type="button" className="outline" onClick={onClose} disabled={saving}>닫기</button>
    </div>
    <div className="transaction-detail-value">
      <span>{row.reversed ? '정정됨 · ' : ''}{kindLabels[row.kind] ?? '기타'}</span>
      <h3>{row.name}</h3><strong>{formatMinor(row.amount, row.currency)}</strong>
    </div>
    <dl className="transaction-fields">
      <dt>거래 일시</dt><dd>{displayDate(row.date)}</dd>
      <dt>카테고리</dt><dd>{row.categories.map((item) => item.name).join(' · ') || '—'}</dd>
      <dt>계좌·카드</dt><dd>{row.accounts.map((item) => item.name).join(' · ') || '—'}{row.payment && <small>{row.payment}</small>}</dd>
      <dt>원본 출처</dt><dd>{row.source}</dd>
      {!editing && <><dt>메모</dt><dd>{annotation?.memo || '—'}</dd>
        <dt>태그</dt><dd>{annotation?.tags.length ? annotation.tags.join(' · ') : '—'}</dd></>}
    </dl>
    {moving && row.categoryAssignments?.length ? <CategoryMoveForm transactionId={row.id} assignments={row.categoryAssignments}
      onClose={() => setMoving(false)} onSaved={() => {
        setMoving(false); setMessage('카테고리를 이동했습니다.'); onCategoryChange()
      }} /> : editing ? <form className="transaction-annotation" onSubmit={save}>
      <label>메모<textarea maxLength={1000} value={memo} disabled={saving} onChange={(event) => setMemo(event.target.value)} /></label>
      <label>태그<input value={tags} disabled={saving} placeholder="쉼표로 구분" onChange={(event) => setTags(event.target.value)} /></label>
      {tagOptions.length > 0 && <div className="row-actions transaction-tag-options" aria-label="등록된 태그">
        {tagOptions.slice(0, 10).map((tag) => {
          const selectedTags = tags.split(',').map((item) => item.trim()).filter(Boolean)
          const selected = selectedTags.includes(tag)
          return <button type="button" className="outline" key={tag} aria-pressed={selected}
            disabled={saving || !selected && selectedTags.length >= 10}
            onClick={() => setTags((selected ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag]).join(', '))}>{tag}</button>
        })}
      </div>}
      <div className="row-actions"><button type="submit" disabled={saving || !dirty}>{saving ? '저장 중' : '저장'}</button>
        <button type="button" className="outline" disabled={saving} onClick={() => {
          if (canLeaveDraft()) { setEditing(false); setMessage('') }
        }}>취소</button></div>
    </form> : <div className="transaction-actions">
      {Boolean(row.categoryAssignments?.length) && <button type="button" className="outline" onClick={() => { setMessage(''); setMoving(true) }}>카테고리 이동</button>}
      {annotations && <button className="outline" type="button" onClick={() => {
        setMemo(annotation?.memo ?? ''); setTags(annotation?.tags.join(', ') ?? ''); setMessage(''); setEditing(true)
      }}>메모·태그 수정</button>}
      {!demo && isPurchase(row.kind) && row.currency === 'KRW' && !row.reversed &&
        <a className="button outline" href={'/account-activity?purchase_id=' + encodeURIComponent(row.id)}>환불·정정</a>}
      {!demo && row.kind === 'purchase_credit' && row.currency === 'KRW' && !row.reversed &&
        <a className="button outline" href={'/card-installments?purchase_id=' + encodeURIComponent(row.id)}>할부 계획</a>}
    </div>}
    {message && <p className="home-note" role="status">{message}</p>}
    {!annotations && <p className="home-note">메모·태그 저장을 사용할 수 없습니다.</p>}
    {!demo && <div className="transaction-detail-sections">
      <details><summary>연결된 환불·정정 기록</summary>
        {detailError ? <p>연결 기록을 불러오지 못했습니다.</p> : !detail ? <p>불러오는 중입니다.</p> : detail.related.length
          ? <ul>{detail.related.map((item) => <li key={item.id}>{kindLabels[item.kind] ?? '원본 거래'} · {item.name}<small>{displayDate(item.date)}</small></li>)}</ul>
          : <p>연결된 기록이 없습니다.</p>}
      </details>
      <details><summary>변경 이력</summary>
        {detailError ? <p>변경 이력을 불러오지 못했습니다.</p> : !detail ? <p>불러오는 중입니다.</p> : detail.audit.length
          ? <ul>{detail.audit.map((item) => <li key={item.id}>{auditLabels[item.action] ?? kindLabels[item.action] ?? '원장 처리 기록'}<small>{displayDate(item.date)}</small></li>)}</ul>
          : <p>표시할 변경 이력이 없습니다.</p>}
      </details>
      {attachmentEndpoint && <details onToggle={(event) => {
        if (event.currentTarget.open && receipts === null && !receiptFailed) void loadReceipts()
      }}><summary>영수증</summary>
        {receiptFailed ? <button type="button" className="outline" onClick={loadReceipts}>영수증 다시 불러오기</button> :
          receipts === null ? <p>불러오는 중입니다.</p> : receipts.length
          ? <ul>{receipts.map((name, index) => <li key={name}><a href={attachmentEndpoint + '?' + new URLSearchParams({ file: name })}>영수증 {index + 1} 다운로드</a></li>)}</ul>
          : <p>첨부된 영수증이 없습니다.</p>}
      </details>}
    </div>}
  </section>
}
