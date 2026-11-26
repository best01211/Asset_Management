'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { paymentLabels, paymentMethods } from '@/lib/transaction-review'
import type { PaymentMethod, ReviewTransaction } from '@/lib/transaction-review'
import type { PurchaseOptions } from '@/lib/supabase/purchase-options'
import { useUnsavedDraft } from '../transactions/draft'
import CategoryPicker from '../category-picker'

function localDateTime(value: string) {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) : ''
}

export default function PendingEditForm({ row, saving, onSavingChange, onCancel, onFinished }: {
  row?: ReviewTransaction
  saving: boolean
  onSavingChange: (saving: boolean) => void
  onCancel: () => void
  onFinished: (message: string) => void
}) {
  const [options, setOptions] = useState<PurchaseOptions | null>(null)
  const [method, setMethod] = useState<PaymentMethod | ''>(row?.payment_method ?? '')
  const [accountId, setAccountId] = useState(row?.payment_account_id ?? '')
  const [categoryId, setCategoryId] = useState(row?.category_id ?? '')
  const [suggested, setSuggested] = useState('')
  const [originalTime] = useState(() => localDateTime(row?.occurred_at ?? new Date().toISOString()))
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  useUnsavedDraft(dirty)
  const manualRequest = useRef<{ fingerprint: string; id: string } | null>(null)
  const ruleRequest = useRef<AbortController | null>(null)
  const categoryManuallySet = useRef(Boolean(row))

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/pending-transactions/options', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error()
        setOptions(await response.json())
      }).catch(() => {
        if (!controller.signal.aborted) setMessage('계좌와 카테고리를 불러오지 못했습니다. 편집을 다시 열어 주세요.')
      })
    return () => { controller.abort(); ruleRequest.current?.abort() }
  }, [])

  const eligible = method ? options?.accounts.filter((account) => account.kind === (method === 'credit_card' ? 'liability' : 'asset')) ?? [] : []

  async function suggestCategory(merchant: string) {
    if (categoryManuallySet.current || !merchant.trim() || !options) return
    ruleRequest.current?.abort()
    const controller = new AbortController()
    ruleRequest.current = controller
    try {
      const response = await fetch('/api/category-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ action: 'suggest', merchant }),
      })
      if (!response.ok) return
      const { category_id, source } = await response.json()
      if (!controller.signal.aborted && !categoryManuallySet.current && options.categories.some((item) => item.id === category_id)) {
        setCategoryId(category_id)
        setSuggested(source)
      }
    } catch {
      // Category selection remains available when suggestions cannot be loaded.
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const values = new FormData(event.currentTarget)
    const amount = values.get('amount_minor')
    const localTime = String(values.get('occurred_at') ?? '')
    const fullTime = localTime.length === 16 ? localTime + ':00' : localTime
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(fullTime)) {
      setMessage('거래 시각을 확인해 주세요.')
      return
    }
    if (!row && !Number.isSafeInteger(Number(amount))) {
      setMessage('지원되는 원화 정수 범위의 금액을 입력해 주세요.')
      return
    }
    onSavingChange(true)
    setMessage('')
    try {
      const draft = {
        merchant: values.get('merchant'),
        amount_minor: row ? amount : Number(amount),
        occurred_at: row && fullTime === originalTime ? row.occurred_at : fullTime + '+09:00',
        payment_method: method,
        payment_account_id: values.get('account'),
        category_id: values.get('category'),
      }
      const fingerprint = JSON.stringify(draft)
      if (!row && manualRequest.current?.fingerprint !== fingerprint) manualRequest.current = { fingerprint, id: crypto.randomUUID() }
      const response = await fetch('/api/pending-transactions' + (row ? '/' + encodeURIComponent(row.id) : ''), {
        method: row ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          ...(row ? { expected_version: row.version } : { request_id: manualRequest.current?.id }),
        }),
      })
      if (response.status === 409 || response.status === 404) {
        onFinished('거래 상태가 변경되었습니다. 최신 목록을 다시 불러옵니다.')
        return
      }
      if (response.status === 401) setMessage('인증 세션을 확인할 수 없습니다.')
      else if (response.status === 422) {
        const result = await response.json()
        setMessage(result.error === 'PENDING_SPLIT_AMOUNT_MISMATCH'
          ? '구매 금액을 바꾸려면 기존 분할을 해제한 뒤 다시 배분해 주세요.'
          : '결제 계좌와 카테고리를 확인해 주세요.')
      }
      else if (response.status === 400) setMessage('가맹점, 금액 및 거래 정보를 확인해 주세요.')
      else if (!response.ok) setMessage('변경 사항을 저장하지 못했습니다. 다시 시도해 주세요.')
      else onFinished(row ? '대기 거래를 수정했습니다.' : '구매를 대기 거래로 기록했습니다.')
    } catch {
      setMessage('저장 결과를 확인하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      onSavingChange(false)
    }
  }

  return (
    <>
      {options && <form onSubmit={save} onChange={() => setDirty(true)} data-unsaved={dirty} data-saving={saving}>
        <div className="fields">
          <label>가맹점<input name="merchant" defaultValue={row?.merchant} required maxLength={200} disabled={saving}
            onBlur={(event) => suggestCategory(event.target.value)} onChange={() => {
              ruleRequest.current?.abort()
            if (suggested) { setCategoryId(''); setSuggested('') }
            }} /></label>
          <label>금액 (원)<input name="amount_minor" inputMode="numeric" pattern="[1-9][0-9]{0,18}"
            defaultValue={row?.amount_minor} required disabled={saving} /></label>
          <label>거래 시각 (한국 시간)<input name="occurred_at" type="datetime-local" step="1"
            defaultValue={originalTime} required disabled={saving} /></label>
          <label>결제 수단<select value={method} required disabled={saving} onChange={(event) => {
            setMethod(event.target.value as PaymentMethod | '')
            setAccountId('')
          }}>{!row && <option value="">수단 선택</option>}
            {paymentMethods.map((value) => <option key={value} value={value}>{paymentLabels[value]}</option>)}</select></label>
          <label>결제 계좌<select name="account" required value={accountId} disabled={saving} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">계좌 선택</option>
            {eligible.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select></label>
          <CategoryPicker name="category" items={[...options.categories, ...(options.archivedCategories ?? [])]}
            value={categoryId || options.categories.find((item) => item.system_key === 'other/1')?.id || ''}
            required disabled={saving} onChange={(next) => {
              ruleRequest.current?.abort()
              categoryManuallySet.current = Boolean(next)
              setCategoryId(next)
              setSuggested('')
            }} />
        </div>
        {suggested === 'merchant_rule' && <p>저장된 가맹점 규칙의 추천입니다.</p>}
        {suggested === 'confirmed_history' && <p>같은 가맹점의 최근 확정 내역을 바탕으로 추천했습니다.</p>}
        {suggested === 'unclassified' && <p>추천 근거가 부족해 미분류로 표시합니다.</p>}
        <button type="submit" disabled={saving || !eligible.length || !options.categories.length}>
          {saving ? '저장 중' : row ? '수정 저장' : '대기에 추가'}
        </button>
      </form>}
      {!options && !message && <p className="recovery-message" role="status">계좌와 카테고리를 불러오는 중입니다.</p>}
      <p className="recovery-message" role="status">{message}</p>
      <button type="button" className="outline" onClick={onCancel} disabled={saving}>{row ? '수정 취소' : '입력 취소'}</button>
    </>
  )
}
