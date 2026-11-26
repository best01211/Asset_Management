'use client'

import { useEffect, useRef, useState } from 'react'
import { budgetWon, isBudgetAmount, sumAmounts } from '@/lib/monthly-budget'
import type { BudgetCategory, BudgetWorkspaceData } from '@/lib/monthly-budget'
import { canLeaveDraft, useUnsavedDraft } from '../transactions/draft'

type Allocation = { category_id: string | null; amount_minor: string | null; expected_version: number }
export type SaveBudget = (changes: Allocation[]) => Promise<string | null>

export function CategoryEditor({ category, save, close }: { category: BudgetCategory; save: SaveBudget; close: () => void }) {
  const initial = category.amount_minor ?? ''
  const [amount, setAmount] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = amount !== initial
  useUnsavedDraft(dirty || busy)
  const valid = amount === '' || isBudgetAmount(amount)
  return <form className="budget-edit" data-unsaved={dirty} data-saving={busy} onSubmit={async (event) => {
    event.preventDefault()
    if (!valid || !dirty || busy) return
    setBusy(true)
    const failure = await save([{ category_id: category.category_id, amount_minor: amount || null, expected_version: category.version ?? 0 }])
    setBusy(false)
    if (failure) setError(failure)
    else close()
  }}>
    <p className="budget-note">현재 설정 {category.limit === null ? '미설정' : budgetWon(category.limit)}</p>
    <label>변경할 예산 (원)<input inputMode="numeric" value={amount} maxLength={19} onChange={(event) => setAmount(event.target.value)} aria-invalid={!valid} disabled={busy} /></label>
    {isBudgetAmount(amount) && <p>변경 후 남은 예산 <strong>{budgetWon(BigInt(amount) - category.actual)}</strong></p>}
    <p className="budget-note">금액을 비우고 저장하면 예산 설정이 해제됩니다.</p>
    {(!valid || error) && <p className="budget-error" role="alert">{!valid ? '0 이상의 원화 정수를 입력해 주세요.' : error}</p>}
    <div className="row-actions"><button type="submit" disabled={!valid || !dirty || busy}>{busy ? '저장 중' : '저장'}</button>
      <button type="button" className="outline" disabled={busy} onClick={() => { if (canLeaveDraft()) close() }}>취소</button></div>
  </form>
}

export function BudgetSettings({ data, save, close }: { data: BudgetWorkspaceData; save: SaveBudget; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const rows = [{ category_id: null, name: '월 목표 예산', amount_minor: data.total?.amount_minor ?? null, version: data.total?.version }, ...data.categories]
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = (id: string | null) => id ?? ''
  const value = (row: typeof rows[number]) => amounts[key(row.category_id)] ?? row.amount_minor ?? ''
  const valid = rows.every((row) => !value(row) || isBudgetAmount(value(row)))
  const changes = rows.filter((row) => (value(row) || null) !== row.amount_minor).map((row) => ({
    category_id: row.category_id, amount_minor: value(row) || null, expected_version: row.version ?? 0,
  }))
  useUnsavedDraft(changes.length > 0 || busy)
  const allocated = sumAmounts(rows.slice(1).map((row) => isBudgetAmount(value(row)) ? BigInt(value(row)) : 0n))
  const total = value(rows[0])
  const difference = valid && isBudgetAmount(total) ? BigInt(total) - allocated : null
  const previous = data.previous
  const canCopy = previous && (previous.total?.amount_minor != null || previous.categories.some((row) => row.amount_minor != null))

  useEffect(() => { dialog.current?.showModal() }, [])

  function copyPrevious() {
    if (!previous) return
    const byCategory = new Map(previous.categories.map((row) => [row.category_id, row.amount_minor]))
    setAmounts(Object.fromEntries(rows.map((row) => [key(row.category_id), (row.category_id ? byCategory.get(row.category_id) : previous.total?.amount_minor) ?? ''])))
  }

  function field(row: typeof rows[number]) {
    return <label key={key(row.category_id)}>{row.name}<input inputMode="numeric" maxLength={19} placeholder="미설정"
      value={value(row)} disabled={busy} aria-invalid={Boolean(value(row)) && !isBudgetAmount(value(row))}
      onChange={(event) => setAmounts({ ...amounts, [key(row.category_id)]: event.target.value })} /></label>
  }

  return <dialog ref={dialog} className="budget-dialog" aria-labelledby="budget-settings-title" onCancel={(event) => {
    event.preventDefault()
    if (canLeaveDraft()) close()
  }}>
    <div className="budget-section-heading"><h2 id="budget-settings-title">전체 예산 설정</h2>
      <button type="button" className="outline" disabled={!canCopy || busy} onClick={copyPrevious}>지난달 예산 복사</button></div>
    <form className="budget-edit" data-unsaved={changes.length > 0} data-saving={busy} onSubmit={async (event) => {
      event.preventDefault()
      if (!valid || !changes.length || busy) return
      setBusy(true)
      const failure = await save(changes)
      setBusy(false)
      if (failure) setError(failure)
      else close()
    }}>
      {field(rows[0])}
      <div className="budget-allocations-total"><span>카테고리 배정 총합 <strong>{budgetWon(allocated)}</strong></span>
        {difference !== null && <span data-tone={difference < 0n ? 'over' : undefined}>{difference < 0n ? '초과 배정 ' + budgetWon(-difference) : '미배정 ' + budgetWon(difference)}</span>}</div>
      <fieldset className="budget-allocation-fields"><legend>카테고리별 배정액 (원)</legend>{rows.slice(1).map(field)}</fieldset>
      {(!valid || error) && <p className="budget-error" role="alert">{!valid ? '0 이상의 원화 정수를 입력해 주세요.' : error}</p>}
      <div className="row-actions"><button type="submit" disabled={!valid || !changes.length || busy}>{busy ? '저장 중' : '저장'}</button>
        <button type="button" className="outline" disabled={busy} onClick={() => { if (canLeaveDraft()) close() }}>취소</button></div>
    </form>
  </dialog>
}
