'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AccountActivity, ActivityType, BalanceCheck } from '@/lib/account-activity'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'

const labels: Record<ActivityType, string> = {
  balance_check: '실제 잔액 대조',
  card_payment: '카드 대금 납부',
  own_transfer: '본인 계좌 이체',
  purchase_refund: '구매 환불',
}

function inputDateTime() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19)
}

const knownErrors: Record<string, string> = {
  SUPABASE_NOT_CONFIGURED: 'Supabase 연결이 설정되지 않았습니다.',
  UNAUTHORIZED: '인증된 사용자 세션이 필요합니다.',
  INVALID_INPUT: '금액·계좌와 시각을 확인해 주세요. 미래 시각은 사용할 수 없습니다.',
  OPENING_BALANCE_REQUIRED: '대조 시각 이전의 초기 잔액이 필요합니다.',
  MOVEMENT_ACCOUNT_MISMATCH: '선택한 계좌를 사용할 수 없습니다.',
  ORIGINAL_PURCHASE_NOT_FOUND: '원본 구매를 찾을 수 없습니다.',
  REFUND_BEFORE_PURCHASE: '환불 시각은 원본 구매 시각보다 같거나 늦어야 합니다.',
  REFUND_EXCEEDS_REMAINING: '환불 금액이 남은 환불 가능액을 초과합니다.',
  REFUND_CATEGORY_UNSUPPORTED: '원본 구매의 분할 내역과 비용 계정을 확인해 주세요.',
  PURCHASE_ALREADY_REVERSED: '이미 정정된 구매입니다.',
  PURCHASE_HAS_REFUNDS: '환불 이력이 있는 구매는 이 화면에서 정정할 수 없습니다.',
  ACCOUNT_NOT_FOUND: '계좌를 찾을 수 없습니다.',
  MOVEMENT_REQUEST_CONFLICT: '이미 다른 내용으로 처리된 요청입니다. 목록을 새로고침해 주세요.',
  BALANCE_CHECK_REQUEST_CONFLICT: '이미 다른 내용으로 처리된 요청입니다. 목록을 새로고침해 주세요.',
  FEE_CATEGORY_INVALID: '수수료에 사용할 비용 카테고리를 확인해 주세요.',
  BALANCE_CHECK_NOT_FOUND: '잔액 대조 기록을 찾을 수 없습니다.',
  BALANCE_CHECK_STALE: '원장 잔액이 바뀌었습니다. 같은 시각의 잔액을 다시 대조해 주세요.',
  NO_BALANCE_DIFFERENCE: '조정할 차액이 없습니다.',
  ADJUSTMENT_AMOUNT_OUT_OF_RANGE: '조정할 차액이 한 전표에 기록할 수 있는 금액을 초과합니다.',
}

export default function AccountActivityWorkspace({ purchaseId }: { purchaseId: string | null }) {
  const [activity, setActivity] = useState<AccountActivity | null>(null)
  const [kind, setKind] = useState<ActivityType>(purchaseId ? 'purchase_refund' : 'balance_check')
  const [from, setFrom] = useState('')
  const [fee, setFee] = useState('0')
  const [adjustment, setAdjustment] = useState<BalanceCheck | null>(null)
  const [adjustmentNotice, setAdjustmentNotice] = useState('')
  const [reversalNotice, setReversalNotice] = useState('')
  const [now, setNow] = useState('')
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef<{ fingerprint: string; id: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const query = purchaseId ? '?' + new URLSearchParams({ purchase_id: purchaseId }) : ''
    // Use browser time when loading or refreshing the activity form.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(inputDateTime())
    fetch('/api/account-activity' + query, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(knownErrors[body.error] ?? '계좌 정보를 불러오지 못했습니다.')
        setActivity(body)
      }).catch((error: Error) => {
        if (!controller.signal.aborted) setLoadError(error.message)
      })
    return () => controller.abort()
  }, [purchaseId, revision])

  const accounts = activity?.accounts ?? []
  const bankAccounts = accounts.filter((account) => account.active && account.kind === 'asset')
  const checkAccounts = accounts.filter((account) => account.opening_effective_at !== null)
  const targets = accounts.filter((account) =>
    account.active && account.id !== from && account.kind === (kind === 'card_payment' ? 'liability' : 'asset'))
  const canRefund = activity?.purchase ? BigInt(activity.purchase.remaining_minor) > 0n : false
  const canSubmit = kind === 'balance_check' ? checkAccounts.length > 0
    : kind === 'purchase_refund' ? canRefund : bankAccounts.length > 0 && targets.length > 0

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || !activity) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const at = String(fields.get('at') ?? '')
    const fullTime = at.length === 16 ? at + ':00' : at
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(fullTime)) {
      setNotice('시각을 확인해 주세요.')
      return
    }
    const body = {
      kind, amount_minor: fields.get('amount'), at: fullTime + '+09:00',
      ...(kind === 'balance_check' ? { account_id: fields.get('account') }
        : kind === 'purchase_refund' ? { original_purchase_id: activity.purchase?.id }
          : { from_account_id: from, to_account_id: fields.get('to') }),
      ...(kind === 'own_transfer' ? { fee_minor: fee, fee_category_id: fee === '0' ? null : fields.get('feeCategory') } : {}),
    }
    const fingerprint = JSON.stringify(body)
    setSaving(true)
    setNotice('')
    try {
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() }
      const response = await fetch('/api/account-activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, request_id: pending.current.id }),
      })
      const result = await response.json()
      if (!response.ok) {
        setNotice(knownErrors[result.error] ?? '기록 결과를 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.')
        return
      }
      pending.current = null
      setNotice(kind === 'balance_check'
        ? '원장 ' + formatWon(result.ledger_minor) + ' · 실제 ' + formatWon(result.actual_minor) + ' · 차이 ' + formatWon(result.difference_minor)
        : labels[kind] + ' 기록을 확정했습니다.')
      form.reset()
      setFrom('')
      setFee('0')
      setLoadError('')
      setRevision((value) => value + 1)
    } catch {
      setNotice('기록 결과를 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  async function approveAdjustment() {
    if (!adjustment || saving) return
    setSaving(true)
    setAdjustmentNotice('')
    try {
      const response = await fetch('/api/account-activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'balance_adjustment', balance_check_id: adjustment.id }),
      })
      const result = await response.json()
      if (!response.ok) {
        setAdjustmentNotice(knownErrors[result.error] ?? '조정 결과를 확인하지 못했습니다.')
        return
      }
      setAdjustment(null)
      setAdjustmentNotice('차액 조정을 원장에 기록했습니다.')
      setRevision((value) => value + 1)
    } catch {
      setAdjustmentNotice('조정 결과를 확인하지 못했습니다. 같은 대조 기록에서 다시 시도할 수 있습니다.')
    } finally {
      setSaving(false)
    }
  }

  async function reversePurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const purchase = activity?.purchase
    if (!purchase || purchase.reversal_id || purchase.has_refunds || saving) return
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    if (!reason) {
      setReversalNotice('정정 사유를 입력해 주세요.')
      return
    }
    setSaving(true)
    setReversalNotice('')
    try {
      const response = await fetch('/api/account-activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'purchase_reversal', original_purchase_id: purchase.id, reason }),
      })
      const result = await response.json()
      if (!response.ok) {
        setReversalNotice(knownErrors[result.error] ?? '정정을 기록하지 못했습니다.')
        if (response.status === 409) setRevision((version) => version + 1)
        return
      }
      setActivity((current) => current?.purchase?.id === purchase.id ? {
        ...current, purchase: { ...purchase, reversal_id: result.transaction_id, reversal_reason: reason, remaining_minor: '0' },
      } : current)
      setReversalNotice('구매 기록을 정정했습니다.')
      setRevision((version) => version + 1)
    } catch {
      setReversalNotice('정정 결과를 확인하지 못했습니다. 같은 사유로 다시 시도할 수 있습니다.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="detail-grid">
    <section className="panel" aria-labelledby="activity-form">
      <h2 id="activity-form">기록 입력</h2>
      {loadError && <p role="alert" className="recovery-message">{loadError}</p>}
      {!activity && !loadError && <p role="status" className="recovery-message">계좌 정보를 불러오는 중입니다.</p>}
      {activity && !loadError && <>
        {!purchaseId && <label className="recovery-message">기록 유형<select value={kind} disabled={saving} onChange={(event) => {
          setKind(event.target.value as ActivityType)
          setFrom('')
          setFee('0')
          setNotice('')
        }}><option value="balance_check">{labels.balance_check}</option>
          <option value="card_payment">{labels.card_payment}</option><option value="own_transfer">{labels.own_transfer}</option>
        </select></label>}
        <form key={kind} onSubmit={submit}>
          {kind === 'purchase_refund' && activity.purchase && <>
            <p>원본 구매 <strong>{activity.purchase.merchant}</strong> · {formatWon(activity.purchase.amount_minor)}</p>
            <p>남은 환불 가능액 <strong>{formatWon(activity.purchase.remaining_minor)}</strong></p>
            {activity.purchase.allocations.length > 1 && <p>카테고리별 원본 금액 {activity.purchase.allocations
              .map((item) => item.name + ' ' + formatWon(item.amount_minor)).join(' · ')}</p>}
          </>}
          {kind === 'balance_check' && <p>동일 시각의 실제 잔액과 원장 잔액을 비교해 차이를 기록합니다.</p>}
          <div className="fields">
            {kind === 'balance_check' ? <label>계좌<select name="account" required disabled={saving} defaultValue="">
              <option value="">계좌 선택</option>{checkAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              : kind !== 'purchase_refund' && <>
                <label>출금 계좌<select required value={from} disabled={saving} onChange={(event) => setFrom(event.target.value)}>
                  <option value="">계좌 선택</option>{bankAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>{kind === 'card_payment' ? '카드 부채 계좌' : '입금 계좌'}<select key={from} name="to" required disabled={saving || !from} defaultValue="">
                  <option value="">계좌 선택</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              </>}
            <label>{kind === 'balance_check' ? '실제 잔액 (원)' : '금액 (원)'}<input name="amount"
              inputMode={kind === 'balance_check' ? 'text' : 'numeric'}
              pattern={kind === 'balance_check' ? '0|-?[1-9][0-9]{0,18}' : '[1-9][0-9]{0,18}'} required disabled={saving} /></label>
            <label>기준 시각 (한국 시간)<input name="at" type="datetime-local" step="1" defaultValue={now} required disabled={saving} /></label>
            {kind === 'own_transfer' && <>
              <label>이체 수수료 (원)<input inputMode="numeric" pattern="0|[1-9][0-9]{0,18}"
                value={fee} onChange={(event) => setFee(event.target.value)} required disabled={saving} /></label>
              {fee !== '0' && <label>수수료 카테고리<select name="feeCategory" required disabled={saving} defaultValue="">
                <option value="">카테고리 선택</option>
                {activity.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>}
            </>}
          </div>
          <button type="submit" disabled={saving || !canSubmit}>{saving ? '기록 중' : kind === 'balance_check' ? '대조 기록' : labels[kind] + ' 확정'}</button>
          {!canSubmit && <p>{kind === 'purchase_refund' && activity.purchase
            ? activity.purchase.reversal_id ? '정정된 구매입니다.' : '환불 가능액을 모두 사용했습니다.'
            : '이 기록에 사용할 계좌나 원본 거래가 필요합니다.'}</p>}
        </form>
        {activity.purchase && <>
          <h2>구매 기록 정정</h2>
          {activity.purchase.reversal_id ? <>
            <p>정정 사유 {activity.purchase.reversal_reason}</p>
            <a href="/transaction-review">거래 검토에서 새 구매 입력</a>
          </> : activity.purchase.has_refunds ? <p>{knownErrors.PURCHASE_HAS_REFUNDS}</p>
            : <form onSubmit={reversePurchase}>
              <p>잘못 입력한 구매를 정정합니다. 원본은 보존되며 구매일의 지출과 계좌 잔액을 역분개합니다.</p>
              <label>정정 사유<input name="reason" required maxLength={200} disabled={saving} /></label>
              <button type="submit" disabled={saving}>구매 기록 정정 확정</button>
            </form>}
          <p role="status">{reversalNotice}</p>
        </>}
      </>}
      <p role="status" className="recovery-message">{notice}</p>
    </section>
    <section className="panel" aria-labelledby="balance-history">
      <h2 id="balance-history">최근 잔액 대조</h2>
      {activity?.checks.length === 0 && <p className="recovery-message">저장된 잔액 대조 기록이 없습니다.</p>}
      {activity && activity.checks.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th scope="col">계좌 · 시각</th><th scope="col" className="numeric">실제</th>
          <th scope="col" className="numeric">원장</th><th scope="col" className="numeric">차이</th><th scope="col">조정</th></tr></thead>
        <tbody>{activity.checks.map((item) => <tr key={item.id}>
          <th scope="row">{item.account_name}<br /><small>{formatSeoulTime(item.observed_at)}</small></th>
          <td className="numeric">{formatWon(item.actual_minor)}</td><td className="numeric">{formatWon(item.ledger_minor)}</td>
          <td className="numeric">{formatWon(item.difference_minor)}</td>
          <td>{item.adjustment_transaction_id ? '조정 완료' : item.difference_minor !== '0' && <button
            type="button" className="outline" disabled={saving} onClick={() => {
              setAdjustment(item)
              setAdjustmentNotice('')
            }}>차액 조정</button>}</td>
        </tr>)}</tbody>
      </table></div>}
      {adjustment && <div className="recovery-message">
        <p>{adjustment.account_name} · {formatSeoulTime(adjustment.observed_at)} · 차이 {formatWon(adjustment.difference_minor)}</p>
        <div className="row-actions">
          <button type="button" disabled={saving} onClick={approveAdjustment}>차액 조정 확정</button>
          <button type="button" className="outline" disabled={saving} onClick={() => setAdjustment(null)}>취소</button>
        </div>
      </div>}
      <p role="status" className="recovery-message">{adjustmentNotice}</p>
    </section>
  </div>
}
