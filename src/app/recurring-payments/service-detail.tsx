'use client'

import { useEffect, useState } from 'react'
import { formatMinor } from '@/lib/transaction-history'
import { formatSeoulTime } from '@/lib/format-finance'
import { cycleLabel, issueLabels, paymentStatuses, serviceStatuses } from '@/lib/recurring-payments'
import type { Occurrence, RecurringCandidate, RecurringService, ServiceHistory, ServiceStatus } from '@/lib/recurring-payments'
import { canLeaveDraft, useUnsavedDraft } from '../transactions/draft'
import ServiceForm from './service-form'

const endpoint = '/api/recurring-payments'
const failures: Record<string, string> = {
  TRANSACTION_ALREADY_LINKED: '이 거래는 이미 다른 회차에 연결되어 있습니다.',
  OCCURRENCE_UNAVAILABLE: '이미 완료되었거나 제외된 회차입니다.',
  CONFIRMED_PURCHASE_NOT_FOUND: '같은 통화의 확정 구매 거래를 선택해 주세요.',
}

function OccurrenceActions({ item, onChanged }: { item: Occurrence; onChanged: () => void }) {
  const [linking, setLinking] = useState(false)
  const [candidates, setCandidates] = useState<RecurringCandidate[] | null>(null)
  const [candidate, setCandidate] = useState('')
  const [lookup, setLookup] = useState('')
  const [search, setSearch] = useState('')
  const [final, setFinal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useUnsavedDraft(Boolean(candidate) && linking)

  useEffect(() => {
    if (!linking) return
    const controller = new AbortController()
    const query = new URLSearchParams({ occurrence: item.id, ...(search ? { transaction: search } : {}) })
    fetch(endpoint + '?' + query, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error()
      const data: RecurringCandidate[] = await response.json()
      if (!controller.signal.aborted) setCandidates(data)
    }).catch(() => { if (!controller.signal.aborted) setMessage('확정 거래를 조회하지 못했습니다. 거래 ID와 연결 상태를 확인해 주세요.') })
    return () => controller.abort()
  }, [item.id, linking, search])

  async function change(action: 'link' | 'unlink' | 'skip' | 'restore', transaction?: string) {
    if (busy) return
    const question = {
      link: final ? '이 확정 거래를 연결하고 회차를 완료 처리할까요?' : '이 확정 거래를 회차에 연결할까요?',
      unlink: '이 거래 연결을 해제할까요? 미결제 예정액이 다시 표시될 수 있습니다.',
      skip: '이번 회차의 남은 금액을 결제 예정에서 제외할까요?',
      restore: '이번 회차를 다시 결제 예정에 포함할까요?',
    }[action]
    if (!window.confirm(question)) return
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: item.id, transaction_id: transaction, final, confirmed: true }),
      })
      if (!response.ok) {
        const result = await response.json()
        setMessage(failures[result.error] ?? '회차를 변경하지 못했습니다. 다시 시도해 주세요.')
        return
      }
      setLinking(false)
      setCandidate('')
      setCandidates(null)
      onChanged()
    } catch { setMessage('저장 결과를 확인하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const open = item.status === 'scheduled' || item.status === 'needs_review'
  const hasLinkedPayment = item.links.some((link) => !link.reversed)
  return <div className="recurring-occurrence-detail" data-unsaved={linking && Boolean(candidate)} data-saving={busy}>
    <dl className="recurring-details recurring-occurrence-facts">
      <dt>예정일</dt><dd><time dateTime={item.due_on}>{item.due_on}</time></dd>
      <dt>결제 상태</dt><dd><span className="recurring-status" data-status={item.status}>{paymentStatuses[item.status]}</span></dd>
      <dt>예상 금액</dt><dd>{formatMinor(item.amount_minor, item.currency)}</dd>
      <dt>실제 연결 금액</dt><dd>{hasLinkedPayment ? formatMinor(item.actual_minor, item.currency) : '미연결'}</dd>
      {hasLinkedPayment && BigInt(item.remaining_minor) > 0n && <><dt>남은 금액</dt><dd>{formatMinor(item.remaining_minor, item.currency)}</dd></>}
    </dl>
    {item.match_issue && <p className="recurring-warning">{issueLabels[item.match_issue]} · 확인 후 연결해 주세요.</p>}
    <h4>연결된 확정 거래</h4>
    {!hasLinkedPayment && <p className="recurring-note">연결된 확정 거래가 없습니다.</p>}
    {item.links.length > 0 && <ul className="recurring-related">{item.links.map((link) => <li key={link.id}>
      <div><strong>{link.name} · {formatMinor(link.amount_minor, item.currency)}</strong>
        <small>{formatSeoulTime(link.occurred_at)} · {link.method === 'automatic' ? '자동 연결' : '사용자 연결'}{link.reversed && ' · 정정됨'}</small>
        {link.method === 'automatic' && <small>가맹점·계좌·금액 동일 · 예정일 전후 2일</small>}
      </div>
      <button type="button" className="outline" disabled={busy} onClick={() => change('unlink', link.id)}>연결 해제</button>
    </li>)}</ul>}
    <div className="row-actions">
      {open && !linking && <button type="button" className="outline" disabled={busy} onClick={() => { setLinking(true); setSearch(''); setMessage('') }}>확정 거래 연결</button>}
      {open && !linking && <button type="button" className="outline" disabled={busy} onClick={() => change('skip')}>회차 제외</button>}
      {item.status === 'skipped' && item.skipped && <button type="button" className="outline" disabled={busy} onClick={() => change('restore')}>제외 취소</button>}
    </div>
    {linking && <div className="recurring-link-form">
      <div className="row-actions">
        <label>거래 ID로 찾기<input value={lookup} placeholder="다른 기간의 확정 거래 ID" onChange={(event) => setLookup(event.target.value)} /></label>
        <button type="button" className="outline" disabled={busy} onClick={() => {
          const next = lookup.trim()
          if (next === search) return
          setCandidate(''); setCandidates(null); setMessage(''); setSearch(next)
        }}>조회</button>
      </div>
      <label>확정 구매 거래<select value={candidate} disabled={busy || !candidates?.length} onChange={(event) => setCandidate(event.target.value)}>
        <option value="">{candidates === null ? '확정 거래 조회 중' : candidates.length ? '연결할 거래 선택' : '연결 가능한 거래 없음'}</option>
        {candidates?.map((row) => <option key={row.id} value={row.id}>{row.name} · {formatMinor(row.amount_minor, row.currency)} · {formatSeoulTime(row.occurred_at)} · {row.account_name}</option>)}
      </select></label>
      <label className="recurring-check"><input type="checkbox" checked={final} disabled={busy} onChange={(event) => setFinal(event.target.checked)} />
        금액이 달라도 이 거래로 회차 완료 처리</label>
      <div className="row-actions">
        <button type="button" disabled={busy || !candidate} onClick={() => change('link', candidate)}>연결</button>
        <button type="button" className="outline" disabled={busy} onClick={() => {
          if (!canLeaveDraft()) return
          setCandidate(''); setLinking(false); setCandidates(null)
        }}>취소</button>
      </div>
    </div>}
    {message && <p role="alert">{message}</p>}
  </div>
}

export default function ServiceDetail({ service, occurrences, item, date, revision, onChanged, onOccurrence }: {
  service: RecurringService; occurrences: Occurrence[]; item?: Occurrence; date: string; revision: number;
  onChanged: (id: string) => void; onOccurrence: (id: string) => void
}) {
  const [edit, setEdit] = useState<ServiceStatus | 'edit' | null>(null)
  const [history, setHistory] = useState<ServiceHistory | null>(null)
  const [historyError, setHistoryError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint + '?' + new URLSearchParams({ service: service.id }), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error()
        const result: ServiceHistory = await response.json()
        if (!controller.signal.aborted) { setHistory(result); setHistoryError(false) }
      }).catch(() => { if (!controller.signal.aborted) setHistoryError(true) })
    return () => controller.abort()
  }, [service.id, revision])

  return <section className="panel recurring-detail" aria-labelledby="recurring-detail-title">
    <div className="recurring-section-heading recurring-detail-heading">
      <div><h2 id="recurring-detail-title">{service.name}</h2>
        <dl className="recurring-detail-statuses">
          <div><dt>서비스</dt><dd><span className="recurring-status" data-status={service.current_status}>{serviceStatuses[service.current_status]}</span></dd></div>
          <div><dt>회차</dt><dd>{item ? <span className="recurring-status" data-status={item.status}>{paymentStatuses[item.status]}</span> : '없음'}</dd></div>
        </dl>
      </div>
      {!edit && <button type="button" className="outline" onClick={() => { if (canLeaveDraft()) setEdit('edit') }}>수정</button>}
    </div>
    {edit ? <ServiceForm service={service} date={date} defaultStatus={edit === 'edit' ? undefined : edit}
      onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); onChanged(id) }} /> : <>
      <div className="recurring-detail-overview">
        <dl className="recurring-detail-amount"><dt>예상 결제 금액</dt><dd>{formatMinor(service.amount_minor, service.currency)}</dd></dl>
        <dl className="recurring-details">
          <dt>결제 주기</dt><dd>{cycleLabel(service.cycle_unit, service.cycle_count)}</dd>
          <dt>다음 결제 예정일</dt><dd>{service.next_due ? <time dateTime={service.next_due}>{service.next_due}</time> : '—'}</dd>
          <dt>결제 수단</dt><dd>{service.account_name ?? '미지정'}</dd>
          <dt>카테고리</dt><dd>{service.category_name ?? '미지정'}</dd>
          {service.note && <><dt>메모</dt><dd>{service.note}</dd></>}
        </dl>
        {service.effective_on > date && <p className="recurring-note">최신 설정은 {service.effective_on}부터 적용됩니다.</p>}
      </div>
      <div className="recurring-detail-subsection">
        <h3>결제 회차 관리</h3>
        {occurrences.length > 1 && <label>회차 선택<select value={item?.id} onChange={(event) => {
          if (canLeaveDraft()) onOccurrence(event.target.value)
        }}>{occurrences.map((entry) => <option key={entry.id} value={entry.id}>{entry.due_on} · {paymentStatuses[entry.status]}</option>)}</select></label>}
        {item ? <OccurrenceActions key={item.id} item={item} onChanged={() => onChanged(service.id)} /> : <p className="recurring-note">조회 월에 예정된 회차가 없습니다.</p>}
      </div>
      <div className="recurring-detail-disclosures">
        <details className="recurring-detail-accordion"><summary>알림 및 자동화 설정</summary>
          <dl className="recurring-details">
            <dt>웹 알림</dt><dd>{service.web_enabled ? '사용' : '꺼짐'}</dd>
            <dt>Android 푸시</dt><dd>{service.push_enabled ? '설정 켜짐 · 발송 연동 전' : '꺼짐'}</dd>
            <dt>사전 알림 시점</dt><dd>{service.advance_days ? service.advance_days + '일 전' : '결제 당일'}</dd>
            <dt>결제 확인 필요 알림</dt><dd>{service.unmatched_alert ? '사용' : '꺼짐'}</dd>
            <dt>자동 거래 매칭</dt><dd>{service.auto_match ? '사용 · 승인된 확정 거래만' : '꺼짐'}</dd>
          </dl>
        </details>
        <details className="recurring-detail-accordion"><summary>최근 결제 이력</summary>
          {historyError ? <p className="recurring-note">이력을 불러오지 못했습니다.</p> : !history ? <p className="recurring-note">이력을 불러오는 중입니다.</p>
            : history.payments.length ? <ul className="recurring-related">{history.payments.map((entry) => <li key={entry.id}>
              <div><span><time dateTime={entry.due_on}>{entry.due_on}</time> · {paymentStatuses[entry.status]}</span>
                {entry.links.map((link) => <small key={link.id}>{link.name} · {formatMinor(link.amount_minor, entry.currency)}{link.reversed && ' · 정정됨'}</small>)}
              </div><strong>{formatMinor(entry.actual_minor, entry.currency)}</strong>
            </li>)}</ul> : <p className="recurring-note">연결된 결제가 없습니다.</p>}
        </details>
        <details className="recurring-detail-accordion"><summary>설정 변경 이력</summary>
          {historyError ? <p className="recurring-note">이력을 불러오지 못했습니다.</p> : !history ? <p className="recurring-note">이력을 불러오는 중입니다.</p> :
            history.revisions.length ? <ul className="recurring-related">{history.revisions.map((entry) => <li key={entry.version}>
              <span>{entry.effective_on} · {entry.name} · {serviceStatuses[entry.status]}</span>
              <strong>{formatMinor(entry.amount_minor, entry.currency)}</strong>
            </li>)}</ul> : <p className="recurring-note">설정 변경 이력이 없습니다.</p>}
        </details>
      </div>
      <div className="recurring-detail-subsection recurring-service-management">
        <h3>서비스 상태 관리</h3>
        <div className="row-actions recurring-service-actions">
          <button type="button" className="outline" onClick={() => {
            if (canLeaveDraft()) setEdit(service.current_status === 'active' ? 'paused' : 'active')
          }}>{service.current_status === 'active' ? '일시중지' : '다시 활성화'}</button>
          {service.current_status !== 'cancelled' && <button type="button" className="outline" onClick={() => {
            if (canLeaveDraft()) setEdit('cancelled')
          }}>해지 상태 변경</button>}
        </div>
        <p className="recurring-note">이곳의 해지는 정기 결제 일정에만 적용됩니다. 실제 구독 해지는 제공업체에서 진행해 주세요.</p>
      </div>
    </>}
  </section>
}
