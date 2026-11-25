'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { amount, demoRecoveryEvents, readDemoFinance, storageKey } from '@/lib/local-finance'
import { recoveryPageSize } from '@/lib/notification-recovery'
import type { RecoveryAccount, RecoveryCategory, RecoveryCursor, RecoveryEvent, RecoveryPage } from '@/lib/notification-recovery'

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
})

function reason(event: RecoveryEvent) {
  switch (event.error_code) {
    case 'missing_fields': return '거래 정보 누락'
    case 'unrecognized_format': return '알림 형식 인식 실패'
    case 'ambiguous_payment': return '결제 내역 식별 필요'
    case 'account_category_mismatch': return '계좌 또는 분류 확인 필요'
    default: return event.status === 'received' ? '미처리 알림' : '거래 정보 확인 필요'
  }
}

function localDateTime(value: string) {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) : ''
}

async function requestPage(cursor: RecoveryCursor | null, signal?: AbortSignal): Promise<RecoveryPage> {
  const params = new URLSearchParams({ limit: String(recoveryPageSize), ...cursor })
  const response = await fetch('/api/notification-events?' + params, { signal })
  if (!response.ok) {
    throw new Error(response.status === 401 ? '인증 세션이 만료되었습니다.' : '복구 목록을 불러오지 못했습니다.')
  }
  return response.json()
}

export default function RecoveryWorkspace({ connected, initialAccounts, initialCategories }: {
  connected: boolean
  initialAccounts: RecoveryAccount[]
  initialCategories: RecoveryCategory[]
}) {
  const [events, setEvents] = useState<RecoveryEvent[]>([])
  const [accounts, setAccounts] = useState(initialAccounts)
  const [categories, setCategories] = useState(initialCategories)
  const [cursor, setCursor] = useState<RecoveryCursor | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [method, setMethod] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!connected) {
      try {
        const finance = readDemoFinance(localStorage)
        // Sample notification data is read from browser storage after hydration.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEvents(finance.recoveryEvents ?? demoRecoveryEvents())
        setAccounts(finance.accounts.map((account) => ({
          id: account.id, name: account.name, kind: account.kind === 'credit' ? 'liability' : 'asset',
        })))
        setCategories(finance.categories)
      } catch {
        setListError('이 브라우저의 샘플 데이터를 불러오지 못했습니다.')
      }
      setLoading(false)
      return
    }

    const controller = new AbortController()
    requestPage(null, controller.signal).then((page) => {
      setEvents(page.events)
      setCursor(page.next_cursor)
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setListError(error.message)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [connected])

  const selected = events.find((event) => event.event_id === selectedId)
  const eligibleAccounts = method ? accounts.filter((account) => account.kind === (method === 'credit_card' ? 'liability' : 'asset')) : []

  async function loadMore(next: RecoveryCursor) {
    setLoading(true)
    setListError('')
    try {
      const page = await requestPage(next)
      setEvents((current) => [...current, ...page.events.filter((event) => !current.some((item) => item.event_id === event.event_id))])
      setCursor(page.next_cursor)
    } catch (error) {
      setListError(error instanceof Error ? error.message : '복구 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || saving) return
    const values = new FormData(event.currentTarget)
    const merchant = String(values.get('merchant') ?? '').trim()
    const amountMinor = amount(values.get('amount'), 1)
    const dateTimeValue = String(values.get('occurredAt') ?? '')
    const accountId = String(values.get('account') ?? '')
    const categoryId = String(values.get('category') ?? '')
    if (!merchant || merchant.length > 200 || amountMinor === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(dateTimeValue)
      || !eligibleAccounts.some((account) => account.id === accountId)
      || !categories.some((category) => category.id === categoryId)) {
      setNotice('거래 정보와 계좌·카테고리를 확인해 주세요.')
      return
    }

    setSaving(true)
    setNotice('')
    try {
      if (connected) {
        const occurredAt = (dateTimeValue.length === 16 ? dateTimeValue + ':00' : dateTimeValue) + '+09:00'
        const response = await fetch('/api/notification-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_event_id: selected.device_event_id,
            source_package: selected.source_package,
            received_at: selected.received_at,
            extraction: {
              status: 'parsed', merchant, amount_minor: amountMinor, occurred_at: occurredAt,
              payment_method: method, payment_account_id: accountId, category_id: categoryId,
            },
          }),
        })
        if (response.status === 401) throw new Error('인증 세션이 만료되었습니다.')
        if (response.status === 409) throw new Error('이 알림의 처리 정보가 변경되었습니다. 목록을 새로고침해 주세요.')
        if (!response.ok) throw new Error('대기 거래를 만들지 못했습니다. 입력 정보를 확인해 주세요.')
        const result = await response.json()
        if (result.status !== 'candidate_ready' || !result.pending_transaction_id) {
          setEvents((current) => current.map((item) => item.event_id === selected.event_id
            ? { ...item, status: 'parse_failed', error_code: result.error_code ?? item.error_code } : item))
          throw new Error('아직 복구가 필요합니다. 결제 계좌와 카테고리를 확인해 주세요.')
        }
      } else {
        const finance = readDemoFinance(localStorage)
        const unresolved = finance.recoveryEvents ?? demoRecoveryEvents()
        if (unresolved.some((item) => item.event_id === selected.event_id)) {
          finance.purchases.unshift({
            id: selected.event_id, merchant, date: dateTimeValue.slice(0, 10), amount: amountMinor,
            accountId, categoryId, status: 'pending',
          })
          finance.recoveryEvents = unresolved.filter((item) => item.event_id !== selected.event_id)
          localStorage.setItem(storageKey, JSON.stringify(finance))
        }
      }

      setEvents((current) => current.filter((item) => item.event_id !== selected.event_id))
      setSelectedId(null)
      setMethod('')
      setNotice('대기 거래를 만들었습니다. 사용자 승인을 기다립니다.')
    } catch (error) {
      setNotice(error instanceof Error && connected ? error.message : '브라우저에 변경 사항을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="recovery-workspace">
      <section className="panel" aria-labelledby="recovery-list-title">
        <h2 id="recovery-list-title">복구 대기 알림</h2>
        {listError && <p role="alert" className="recovery-message">{listError} <a href="">목록 새로고침</a></p>}
        {loading && !events.length && <p className="recovery-message" role="status">알림을 불러오는 중입니다.</p>}
        {!loading && !listError && !events.length && !cursor && <p className="recovery-message">복구할 알림이 없습니다.</p>}
        <ul className="recovery-list">{events.map((item) => (
          <li key={item.event_id}>
            <button type="button" aria-pressed={item.event_id === selectedId} disabled={saving}
              onClick={() => {
                if (selectedId !== item.event_id) {
                  setSelectedId(item.event_id)
                  setMethod('')
                  setNotice('')
                }
              }}>
              <strong>{reason(item)}</strong>
              <small>{item.source_package} · {dateTime.format(new Date(item.received_at))}</small>
            </button>
          </li>
        ))}</ul>
        {cursor && <button type="button" className="outline" disabled={loading || saving} onClick={() => loadMore(cursor)}>
          {loading ? '불러오는 중' : '알림 더 보기'}
        </button>}
      </section>

      <section className="panel" aria-labelledby="recovery-form-title">
        <h2 id="recovery-form-title">거래 정보 보완</h2>
        {!selected && <p className="recovery-message">목록에서 복구할 알림을 선택하세요.</p>}
        {selected && <form key={selected.event_id} onSubmit={recover}>
          <p>{reason(selected)} · {selected.source_package}</p>
          <div className="fields">
            <label>가맹점<input name="merchant" maxLength={200} required disabled={saving} /></label>
            <label>금액 (원)<input name="amount" type="number" min="1" max="100000000000" required disabled={saving} /></label>
            <label>거래 시각 (한국 시간)<input name="occurredAt" type="datetime-local" step="1" required defaultValue={localDateTime(selected.received_at)} disabled={saving} /></label>
          </div>
          <div className="fields">
            <label>결제 수단<select required value={method} disabled={saving} onChange={(event) => setMethod(event.target.value)}>
              <option value="">수단 선택</option><option value="credit_card">신용카드</option>
              <option value="debit_card">체크카드</option><option value="cash">현금</option>
            </select></label>
            <label>결제 계좌<select key={method} name="account" required disabled={saving || !method} defaultValue="">
              <option value="">계좌 선택</option>
              {eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select></label>
            <label>카테고리<select name="category" required disabled={saving} defaultValue="">
              <option value="">카테고리 선택</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select></label>
          </div>
          {(!accounts.length || !categories.length) && <p>복구하려면 결제 계좌와 카테고리가 필요합니다.</p>}
          {method && !eligibleAccounts.length && <p>이 결제 수단에 연결할 수 있는 계좌가 없습니다.</p>}
          <button type="submit" disabled={saving || !eligibleAccounts.length || !categories.length}>
            {saving ? '저장 중' : '대기 거래 만들기'}
          </button>
        </form>}
        <p className="recovery-message" role="status">{notice}</p>
        {!selected && notice && <a href={connected ? '/transaction-review' : '/demo/transactions'}>대기 거래 확인</a>}
      </section>
    </div>
  )
}
