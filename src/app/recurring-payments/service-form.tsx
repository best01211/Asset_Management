'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CategoryOption } from '@/lib/category-catalog'
import { parseRecurringAmount, recurringAmountInput, serviceStatuses } from '@/lib/recurring-payments'
import type { RecurringService, ServiceInput, ServiceStatus } from '@/lib/recurring-payments'
import CategoryPicker from '../category-picker'
import { canLeaveDraft, useUnsavedDraft } from '../transactions/draft'

type Options = { categories: CategoryOption[]; accounts: { id: string; name: string; currency: string; active: boolean }[] }
const errors: Record<string, string> = {
  STALE_RECURRING_SERVICE: '다른 곳에서 설정을 변경했습니다. 최신 설정을 다시 열어 주세요.',
  INVALID_EFFECTIVE_DATE: '저장된 마지막 적용일과 오늘 중 더 늦은 날짜부터 적용할 수 있습니다.',
  CATEGORY_UNAVAILABLE: '사용 중인 지출 카테고리를 선택해 주세요.',
  PAYMENT_ACCOUNT_UNAVAILABLE: '결제 통화와 같은 통화의 계좌·카드를 선택해 주세요.',
  INVALID_INPUT: '서비스명, 금액, 날짜 및 반복 주기를 확인해 주세요.',
}

export default function ServiceForm({ service, date, defaultStatus, onClose, onSaved }: {
  service?: RecurringService; date: string; defaultStatus?: ServiceStatus; onClose: () => void; onSaved: (id: string) => void
}) {
  const [options, setOptions] = useState<Options | null>(null)
  const [optionsError, setOptionsError] = useState(false)
  const [currency, setCurrency] = useState(service?.currency ?? 'KRW')
  const [account, setAccount] = useState(service?.account_id ?? '')
  const [category, setCategory] = useState(service?.category_id ?? '')
  const [preset, setPreset] = useState(!service || service.cycle_unit === 'month' && service.cycle_count === 1 ? 'monthly' :
    service.cycle_unit === 'day' && service.cycle_count === 7 ? 'weekly' :
      service.cycle_unit === 'month' && service.cycle_count === 12 ? 'yearly' : 'custom')
  const [status, setStatus] = useState<ServiceStatus>(defaultStatus ?? service?.status ?? 'active')
  const [dirty, setDirty] = useState(Boolean(defaultStatus && defaultStatus !== service?.status))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const draftId = useRef<string | null>(null)
  useUnsavedDraft(dirty)
  const effectiveFrom = service && service.effective_on > date ? service.effective_on : date

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/recurring-payments?options=1', { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error()
      const result: Options = await response.json()
      if (!controller.signal.aborted) setOptions(result)
    }).catch(() => { if (!controller.signal.aborted) setOptionsError(true) })
    return () => controller.abort()
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) ?? '').trim()
    const amount = parseRecurringAmount(text('amount'), currency)
    const end = text('end')
    const anchor = text('anchor')
    const aliases = [...new Set(text('aliases').split(',').map((item) => item.trim()).filter(Boolean))]
    const cycle = preset === 'custom' ? Number(text('count')) : preset === 'weekly' ? 7 : preset === 'yearly' ? 12 : 1
    const unit = preset === 'custom' ? text('unit') === 'day' ? 'day' : 'month' : preset === 'weekly' ? 'day' : 'month'
    if (!amount || !anchor || end && end < anchor || !Number.isInteger(cycle) || cycle < 1 || cycle > (unit === 'day' ? 366 : 12)
      || aliases.length > 12 || aliases.some((item) => item.length > 100)) {
      setMessage('금액, 종료일, 반복 주기 또는 별칭을 확인해 주세요.')
      return
    }
    if (status === 'cancelled' && service?.status !== 'cancelled'
      && !window.confirm('이 서비스의 향후 결제 회차를 제외할까요? 실제 구독 해지는 제공업체에서 진행해야 합니다.')) return
    draftId.current ??= service?.id ?? crypto.randomUUID()
    const settings: ServiceInput = {
      name: text('name'), amount_minor: amount, currency, anchor_on: anchor, end_on: end || null,
      effective_on: service ? text('effective') : anchor < date ? anchor : date,
      category_id: category || null, account_id: account || null, cycle_unit: unit, cycle_count: cycle, status,
      aliases, auto_match: form.has('auto_match'), web_enabled: form.has('web'), push_enabled: form.has('push'),
      advance_days: Number(text('days')), unmatched_alert: form.has('unmatched'), note: text('note'),
    }
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/recurring-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', id: draftId.current, expected: service?.version ?? 0, settings }),
      })
      const result = await response.json()
      if (!response.ok) { setMessage(errors[result.error] ?? '정기 결제를 저장하지 못했습니다.'); return }
      onSaved(result.id)
    } catch { setMessage('저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 시도할 수 있습니다.') }
    finally { setSaving(false) }
  }

  return <form className="recurring-form" onSubmit={save} onChange={() => setDirty(true)} data-unsaved={dirty} data-saving={saving}>
    <fieldset disabled={saving}>
      <div className="recurring-form-grid">
        <label>서비스명<input name="name" defaultValue={service?.name} required maxLength={100} /></label>
        <label>예상 금액<input name="amount" inputMode="decimal" required defaultValue={service ? recurringAmountInput(service.amount_minor, service.currency) : ''} /></label>
        <label>통화 코드<input name="currency" value={currency} required pattern="[A-Z]{3}" maxLength={3} onChange={(event) => {
          setCurrency(event.target.value.toUpperCase()); setAccount('')
        }} /></label>
        <label>결제 주기<select value={preset} onChange={(event) => setPreset(event.target.value)}>
          <option value="weekly">매주</option><option value="monthly">매월</option><option value="yearly">매년</option><option value="custom">사용자 지정</option>
        </select></label>
        {preset === 'custom' && <>
          <label>반복 간격<input name="count" type="number" min="1" max="366" step="1" defaultValue={service?.cycle_count ?? 1} required /></label>
          <label>반복 단위<select name="unit" defaultValue={service?.cycle_unit ?? 'day'}>
            <option value="day">일</option><option value="month">개월</option></select></label>
        </>}
        <label>{service ? '결제 기준일' : '첫 결제 예정일'}<input type="date" name="anchor" required
          min="1900-01-01" max="9997-12-31" defaultValue={service?.anchor_on ?? date} /></label>
        {service && <label>변경 적용일<input name="effective" type="date" min={effectiveFrom} max="9997-12-31"
          required defaultValue={effectiveFrom} /></label>}
        {service && <label>서비스 상태<select value={status} onChange={(event) => setStatus(event.target.value as ServiceStatus)}>
          {Object.entries(serviceStatuses).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select></label>}
      </div>
      {(preset === 'monthly' || preset === 'yearly' || preset === 'custom') &&
        <p className="recurring-note">월 단위 결제는 기준일이 없는 달의 마지막 날에 예정됩니다.</p>}
      {status === 'cancelled' && <p className="recurring-note">해지 상태는 이 앱의 결제 일정에 적용됩니다. 실제 구독은 제공업체에서 관리합니다.</p>}
      <details className="recurring-form-advanced" open={service ? true : undefined}>
        <summary>결제 수단·알림·고급 설정</summary>
        <div className="recurring-form-grid">
          {options && <CategoryPicker label="지출 카테고리" items={options.categories} value={category} onChange={setCategory} placeholder="미지정" />}
          {options && <label>결제 계좌·카드<select value={account} onChange={(event) => setAccount(event.target.value)}>
            <option value="">미지정</option>{options.accounts.filter((item) => item.currency === currency && (item.active || item.id === service?.account_id))
              .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>}
          <label>종료 예정일<input name="end" type="date" max="9997-12-31" defaultValue={service?.end_on ?? ''} /></label>
          <label>결제 가맹점 별칭<input name="aliases" placeholder="쉼표로 구분" defaultValue={service?.aliases.join(', ')} /></label>
          <label>사전 알림<select name="days" defaultValue={service?.advance_days ?? 1}>{[0, 1, 3, 7].map((day) =>
            <option key={day} value={day}>{day ? day + '일 전' : '결제 당일'}</option>)}</select></label>
          <label className="recurring-note-field">메모<textarea name="note" maxLength={1000} defaultValue={service?.note} rows={2} /></label>
        </div>
        {optionsError && <p className="recurring-note" role="status">카테고리와 계좌 선택 항목을 불러오지 못했습니다.</p>}
        <div className="recurring-checks">
          <label><input type="checkbox" name="auto_match" defaultChecked={service?.auto_match ?? true} />확정 거래 자동 연결</label>
          <label><input type="checkbox" name="web" defaultChecked={service?.web_enabled ?? true} />웹 알림</label>
          <label><input type="checkbox" name="unmatched" defaultChecked={service?.unmatched_alert ?? true} />미연결 확인 알림</label>
          <label><input type="checkbox" name="push" defaultChecked={service?.push_enabled ?? false} />Android 푸시 설정</label>
        </div>
        <p className="recurring-note">웹 알림은 앱 안에서 표시됩니다. Android 푸시는 발송 연동 전이며 설정만 저장합니다.</p>
      </details>
    </fieldset>
    {message && <p role="alert">{message}</p>}
    <div className="row-actions">
      <button type="submit" disabled={saving || !dirty || Boolean(service && !options && (service.category_id || service.account_id) && !optionsError)}>
        {saving ? '저장 중' : '저장'}</button>
      <button type="button" className="outline" disabled={saving} onClick={() => { if (canLeaveDraft()) onClose() }}>취소</button>
    </div>
  </form>
}
