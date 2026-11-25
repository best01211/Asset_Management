'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { CardInstallmentPlan } from '@/lib/card-installments'
import { formatWon } from '@/lib/format-finance'

const messages: Record<string, string> = {
  INSTALLMENT_VERSION_CONFLICT: '다른 화면에서 계획이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  INSTALLMENT_MONTH_INVALID: '첫 청구 월은 구매 월 이후여야 하며, 마지막 청구 월이 조회 범위에 있어야 합니다.',
  INSTALLMENT_PRINCIPAL_INVALID: '계획 원금은 각 회차에 1원 이상 배분하고 남은 구매 원금을 넘지 않아야 합니다.',
  PURCHASE_ALREADY_REVERSED: '정정된 구매의 계획은 변경할 수 없습니다.',
  UNAUTHORIZED: '인증된 사용자 세션이 필요합니다.',
  INVALID_INPUT: '청구 월, 회차와 금액을 확인해 주세요.',
}

export default function PlanEditor({ initialPlan }: { initialPlan: CardInstallmentPlan }) {
  const router = useRouter()
  const [plan, setPlan] = useState(initialPlan)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function save(fields: FormData | null) {
    if (saving || plan.reversed) return
    setSaving(true)
    setMessage('')
    const payload = {
      purchase_id: plan.purchase_id,
      version: plan.version,
      first_month: fields?.get('firstMonth') ?? null,
      payment_count: fields ? Number(fields.get('paymentCount')) : null,
      principal_minor: fields?.get('principal') ?? null,
      fee_minor: fields?.get('fee') ?? null,
    }
    try {
      const response = await fetch('/api/card-installments', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        setMessage(messages[result.error] ?? '할부 계획 저장 결과를 확인하지 못했습니다.')
        return
      }
      setPlan(result)
      setMessage(fields ? '할부 계획을 저장했습니다.' : '할부 계획을 해제했습니다.')
      router.refresh()
    } catch {
      setMessage('할부 계획 저장 결과를 확인하지 못했습니다. 새로고침해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void save(new FormData(event.currentTarget))
  }

  return <section className="panel" aria-labelledby="installment-plan">
    <h2 id="installment-plan">{plan.merchant} 할부 계획</h2>
    {plan.reversed ? <p>정정된 구매입니다.</p> : <>
      <p>구매 월 {plan.purchase_month} · 계획 가능 원금 {formatWon(plan.available_minor)}</p>
      {plan.needs_review && <p className="recovery-message">환불이 기록됐습니다. 카드 청구 내역을 확인한 뒤 계획을 수정하거나 해제해 주세요.</p>}
      {BigInt(plan.available_minor) >= 2n && <form key={plan.version} onSubmit={submit}>
        <div className="fields">
          <label>첫 청구 월<input name="firstMonth" type="month" min={plan.purchase_month} max="9998-12"
            defaultValue={plan.first_month ?? plan.purchase_month} required disabled={saving} /></label>
          <label>할부 회차<input name="paymentCount" type="number" min={2} max={60}
            defaultValue={plan.payment_count ?? 2} required disabled={saving} /></label>
          <label>계획 원금 (원)<input name="principal" inputMode="numeric" pattern="[1-9][0-9]{0,18}"
            defaultValue={plan.needs_review ? plan.available_minor : plan.principal_minor ?? plan.available_minor}
            required disabled={saving} /></label>
          <label>예상 수수료 합계 (원)<input name="fee" inputMode="numeric" pattern="0|[1-9][0-9]{0,18}"
            defaultValue={plan.fee_minor ?? '0'} required disabled={saving} /></label>
        </div>
        <button type="submit" disabled={saving}>{saving ? '저장 중' : '할부 계획 저장'}</button>
      </form>}
      {plan.first_month && <button className="outline" type="button" disabled={saving}
        onClick={() => void save(null)}>할부 계획 해제</button>}
    </>}
    <p role="status">{message}</p>
  </section>
}
