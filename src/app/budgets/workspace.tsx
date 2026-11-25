'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { formatWon } from '@/lib/format-finance'
import { isBudgetMonth } from '@/lib/monthly-budget'
import type { BudgetLimit, MonthlyBudget } from '@/lib/monthly-budget'

function integerDisplay(limit: string | null | undefined, spent: string) {
  if (limit == null) return '예산 미설정'
  const remaining = BigInt(limit) - BigInt(spent)
  return (remaining < 0n ? '초과 ' : '남음 ') + formatWon((remaining < 0n ? -remaining : remaining).toString())
}

function BudgetForm({ limit, name, disabled, onSave }: {
  limit: BudgetLimit | null
  name: string
  disabled: boolean
  onSave: (amount: string | null) => void
}) {
  const saved = limit?.amount_minor ?? null
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = new FormData(event.currentTarget).get('amount')
    if (typeof amount === 'string') onSave(amount)
  }
  return <form className="budget-form" onSubmit={submit}>
    <label>{name} 예산 (원)<input name="amount" inputMode="numeric" pattern="0|[1-9][0-9]{0,18}"
      defaultValue={saved ?? ''} required disabled={disabled} /></label>
    <div className="row-actions">
      <button type="submit" disabled={disabled}>저장</button>
      {saved !== null && <button type="button" className="outline" disabled={disabled} onClick={() => onSave(null)}>예산 해제</button>}
    </div>
  </form>
}

export default function BudgetWorkspace() {
  const [month, setMonth] = useState('')
  const [budget, setBudget] = useState<MonthlyBudget | null>(null)
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    // The static page must select the current month after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMonth(new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date()))
  }, [])

  useEffect(() => {
    if (!isBudgetMonth(month)) return
    const controller = new AbortController()
    fetch('/api/budgets?' + new URLSearchParams({ month }), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) throw new Error('월별 예산을 보려면 인증된 사용자 세션이 필요합니다.')
        if (response.status === 503) throw new Error('Supabase 연결이 설정되지 않았습니다.')
        if (!response.ok) throw new Error('월별 예산을 불러오지 못했습니다.')
        setBudget(await response.json())
      }).catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message)
      })
    return () => controller.abort()
  }, [month, revision])

  async function save(category: string | null, limit: BudgetLimit | null, amount: string | null) {
    if (saving || !isBudgetMonth(month)) return
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/budgets', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, category_id: category, amount_minor: amount, expected_version: limit?.version ?? 0 }),
      })
      if (response.status === 409) {
        setNotice('예산이 변경되었습니다. 최신 값을 다시 불러옵니다.')
      } else if (response.status === 400) {
        setNotice('예산 금액을 확인해 주세요.')
        return
      } else if (!response.ok) {
        setNotice('예산을 저장하지 못했습니다.')
        return
      } else {
        setNotice(amount === null ? '예산 설정을 해제했습니다.' : '예산을 저장했습니다.')
      }
      setError('')
      setBudget(null)
      setRevision((value) => value + 1)
    } catch {
      setNotice('저장 결과를 확인하지 못했습니다. 새로고침해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  return <>
    <div className="section-heading recovery-heading">
      <h1>월별 예산</h1>
      <label>조회 월<input type="month" min="1900-01" max="9998-12" value={month} disabled={saving}
        onChange={(event) => {
          if (isBudgetMonth(event.target.value)) {
            setMonth(event.target.value)
            setBudget(null)
            setError('')
            setNotice('')
          }
        }} /></label>
    </div>
    <p className="recovery-message" role={error ? 'alert' : 'status'}>{error || notice}</p>
    {!budget && !error && <p role="status" className="recovery-message">월별 예산을 불러오는 중입니다.</p>}
    {budget && <>
      <section className="panel" aria-labelledby="total-budget">
        <h2 id="total-budget">월 전체 예산</h2>
        <p className="recovery-message">확정 순지출 {formatWon(budget.spent_minor)} · {integerDisplay(budget.total?.amount_minor, budget.spent_minor)}</p>
        <BudgetForm key={budget.month + ':' + budget.total?.version} limit={budget.total} name="월 전체"
          disabled={saving} onSave={(amount) => save(null, budget.total, amount)} />
      </section>
      <section className="panel budget-category-panel" aria-labelledby="category-budgets">
        <h2 id="category-budgets">카테고리 예산</h2>
        {!budget.categories.length && <p className="recovery-message">원화 비용 카테고리가 없습니다.</p>}
        {budget.categories.length > 0 && <div className="table-scroll"><table>
          <thead><tr><th scope="col">카테고리</th><th scope="col">확정 순지출</th><th scope="col">예산 상태</th><th scope="col">예산 설정</th></tr></thead>
          <tbody>{budget.categories.map((item) => <tr key={item.category_id}>
            <th scope="row">{item.name}</th><td>{formatWon(item.spent_minor)}</td>
            <td>{integerDisplay(item.amount_minor, item.spent_minor)}</td>
            <td><BudgetForm key={budget.month + ':' + item.version} limit={item} name={item.name}
              disabled={saving} onSave={(amount) => save(item.category_id, item, amount)} /></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </>}
  </>
}
