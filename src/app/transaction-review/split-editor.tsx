'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { formatWon } from '@/lib/format-finance'
import type { ReviewTransaction } from '@/lib/transaction-review'

type Allocation = { category_id: string; amount_minor: string }
type AllocationRow = Allocation & { key: string }
type Category = { id: string; name: string }
const integer = /^[1-9]\d{0,18}$/

export default function SplitEditor({ transaction, saving, onSavingChange, onCancel, onFinished }: {
  transaction: ReviewTransaction
  saving: boolean
  onSavingChange: (value: boolean) => void
  onCancel: () => void
  onFinished: (message: string) => void
}) {
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [rows, setRows] = useState<AllocationRow[]>([])
  const [hadSplits, setHadSplits] = useState(false)
  const [notice, setNotice] = useState('')
  const endpoint = '/api/pending-transactions/' + encodeURIComponent(transaction.id) + '/splits'

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error()
      const data: { allocations: Allocation[]; categories: Category[] } = await response.json()
      setRows(data.allocations.map((item) => ({ ...item, key: item.category_id })))
      setCategories(data.categories)
      setHadSplits(data.allocations.length > 0)
    }).catch(() => {
      if (!controller.signal.aborted) setNotice('분할 내역과 카테고리를 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [endpoint])

  const total = rows.reduce((sum, row) => sum + (integer.test(row.amount_minor) ? BigInt(row.amount_minor) : 0n), 0n)
  const valid = rows.length >= 2 && total === BigInt(transaction.amount_minor)
    && rows.every((row) => row.category_id && integer.test(row.amount_minor))
    && new Set(rows.map((row) => row.category_id)).size === rows.length

  function update(key: string, values: Partial<Allocation>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...values } : row))
  }

  async function save(remove = false) {
    if (saving || (!remove && !valid)) return
    onSavingChange(true)
    setNotice('')
    try {
      const response = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_version: transaction.version,
          allocations: remove ? [] : rows.map(({ category_id, amount_minor }) => ({ category_id, amount_minor })),
        }),
      })
      if (response.status === 409 || response.status === 404) onFinished('거래 상태가 변경되어 최신 목록을 다시 불러옵니다.')
      else if (response.status === 422) setNotice('선택한 카테고리와 분할 금액의 합계를 확인해 주세요.')
      else if (!response.ok) setNotice('분할을 저장하지 못했습니다.')
      else onFinished(remove ? '분할을 해제했습니다.' : '대기 거래의 분할을 저장했습니다.')
    } catch {
      setNotice('분할 저장 결과를 확인하지 못했습니다. 목록을 다시 확인해 주세요.')
    } finally {
      onSavingChange(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void save()
  }

  return <>
    <p className="recovery-message">구매 금액 {formatWon(transaction.amount_minor)} · 분할 합계 {formatWon(total.toString())}</p>
    {!categories && !notice && <p role="status">분할을 불러오는 중입니다.</p>}
    {categories && <form onSubmit={submit}>
      {rows.map((row, index) => <div className="fields" key={row.key}>
        <label>카테고리 {index + 1}<select required value={row.category_id} disabled={saving}
          onChange={(event) => update(row.key, { category_id: event.target.value })}>
          <option value="">카테고리 선택</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <label>배분 금액 {index + 1} (원)<input inputMode="numeric" pattern="[1-9][0-9]{0,18}" value={row.amount_minor}
          required disabled={saving} onChange={(event) => update(row.key, { amount_minor: event.target.value })} /></label>
        <button type="button" className="outline" disabled={saving} onClick={() => setRows((items) => items.filter((item) => item.key !== row.key))}>
          항목 제거
        </button>
      </div>)}
      <p>서로 다른 카테고리 2개 이상에 나누고 합계를 구매 금액과 맞추세요.</p>
      <div className="row-actions">
        <button type="button" className="outline" disabled={saving || rows.length >= Math.min(30, categories.length)}
          onClick={() => setRows((items) => [...items, { key: crypto.randomUUID(), category_id: '', amount_minor: '' }])}>
          분할 항목 추가
        </button>
        <button type="submit" disabled={saving || !valid}>분할 저장</button>
        {hadSplits && <button type="button" className="outline" disabled={saving} onClick={() => save(true)}>분할 해제</button>}
      </div>
    </form>}
    <p role="status" className="recovery-message">{notice}</p>
    <button type="button" className="outline" disabled={saving} onClick={onCancel}>분할 닫기</button>
  </>
}
