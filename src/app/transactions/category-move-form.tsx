'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { CategoryAssignment, CategoryOption } from '@/lib/category-catalog'
import CategoryPicker from '../category-picker'
import { canLeaveDraft, useUnsavedDraft } from './draft'

export default function CategoryMoveForm({ transactionId, assignments, onClose, onSaved }: {
  transactionId: string; assignments: CategoryAssignment[]; onClose: () => void; onSaved: () => void
}) {
  const [source, setSource] = useState(assignments[0].sourceId)
  const [target, setTarget] = useState('')
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const assignment = assignments.find((item) => item.sourceId === source)
  const dirty = Boolean(target)
  useUnsavedDraft(dirty)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/pending-transactions/options', { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error()
      const data = await response.json()
      if (!controller.signal.aborted) setOptions(data.categories)
    }).catch(() => { if (!controller.signal.aborted) setMessage('소분류를 불러오지 못했습니다.') })
    return () => controller.abort()
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = options.find((item) => item.id === target)
    if (!assignment || !next || target === assignment.currentId || saving) return
    if (!window.confirm(assignment.name + '에서 ' + (next.group ? next.group + ' → ' : '') + next.name + '으로 이동하시겠습니까?')) return
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/transactions/' + encodeURIComponent(transactionId) + '/category', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: source, current_id: assignment.currentId, target_id: target, confirmed: true }),
      })
      if (response.status === 409) { setMessage('분류가 이미 변경되었습니다. 목록을 다시 열어 주세요.'); return }
      if (!response.ok) throw new Error()
      onSaved()
    } catch { setMessage('이동하지 못했습니다. 사용 중인 지출 소분류인지 확인해 주세요.') }
    finally { setSaving(false) }
  }

  return <form className="transaction-annotation" onSubmit={save} data-unsaved={dirty} data-saving={saving}>
    {assignments.length > 1 ? <label>이동할 배분<select value={source} disabled={saving} onChange={(event) => {
      setSource(event.target.value); setTarget('')
    }}>{assignments.map((item) => <option key={item.sourceId} value={item.sourceId}>{item.name}</option>)}</select></label> :
      <p>현재 소분류 {assignment?.name}</p>}
    <CategoryPicker label="새 카테고리" items={options} value={target} onChange={setTarget} required disabled={saving} />
    <p>이동하면 카테고리별 집계와 연결된 환불의 분류에 반영됩니다.</p>
    <div className="row-actions">
      <button type="submit" disabled={saving || !target || target === assignment?.currentId}>이동</button>
      <button type="button" className="outline" disabled={saving} onClick={() => { if (canLeaveDraft()) onClose() }}>취소</button>
    </div>
    {message && <p role="status">{message}</p>}
  </form>
}
