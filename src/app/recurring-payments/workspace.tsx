'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { formatMinor } from '@/lib/transaction-history'
import { alertLabels, changeMonth, cycleLabel, monthTotals, paymentStatuses, recurringDueLabel, serviceStatuses } from '@/lib/recurring-payments'
import type { Occurrence, PaymentStatus, RecurringAlert, RecurringMonth, RecurringService } from '@/lib/recurring-payments'
import { canLeaveDraft } from '../transactions/draft'
import ServiceDetail from './service-detail'
import ServiceForm from './service-form'

const endpoint = '/api/recurring-payments'
const views = ['schedule', 'services'] as const
type View = typeof views[number]

function href(month: string, id?: string, occurrence?: string) {
  return '/recurring-payments?' + new URLSearchParams({ month, ...(id ? { id } : {}), ...(occurrence ? { occurrence } : {}) })
}
function statusBadge(status: PaymentStatus) {
  return <span className="recurring-status" data-status={status}>{paymentStatuses[status]}</span>
}
function sumLabels(totals: ReturnType<typeof monthTotals>, key: 'expected' | 'actual' | 'remaining') {
  const amounts = [...totals].filter(([, value]) => value[key] > 0n).sort(([a], [b]) => a === 'KRW' ? -1 : b === 'KRW' ? 1 : a.localeCompare(b))
  return amounts.length ? amounts.map(([currency, total]) => formatMinor(total[key].toString(), currency)) : ['0원']
}

function Summary({ data, next }: { data: RecurringMonth; next?: Occurrence }) {
  const totals = monthTotals(data.occurrences)
  return <section className="recurring-summary" aria-label="월 정기 결제 요약">
    <div className="recurring-main-metric">
      <h2>앞으로 결제될 금액</h2>
      <p>{sumLabels(totals, 'remaining').map((value) => <strong key={value}>{value}</strong>)}</p>
      <small>선택한 월의 미결제 회차 기준</small>
    </div>
    <dl>
      <div><dt>이 달 총 예정 금액</dt><dd>{sumLabels(totals, 'expected').map((value) => <span key={value}>{value}</span>)}</dd></div>
      <div><dt>이 달 결제 완료 금액</dt><dd>{sumLabels(totals, 'actual').map((value) => <span key={value}>{value}</span>)}</dd></div>
      <div><dt>가장 가까운 결제</dt><dd>{next?.name ?? '—'}</dd>
        {next && <small><time dateTime={next.due_on}>{next.due_on}</time> · {recurringDueLabel(data.today, next.due_on)}</small>}</div>
    </dl>
  </section>
}

function Timeline({ items, date, nextId, selectedId, choose }: {
  items: Occurrence[]; date: string; nextId?: string; selectedId?: string; choose: (item: Occurrence) => void
}) {
  const groups = new Map<string, Occurrence[]>()
  for (const item of items) {
    const group = groups.get(item.due_on)
    if (group) group.push(item)
    else groups.set(item.due_on, [item])
  }
  return <div className="recurring-timeline">
    {items.length ? <ol className="recurring-timeline-groups">{[...groups].map(([due, group]) => <li key={due}>
      <ul className="recurring-timeline-day">{group.map((item, index) => <li key={item.id}>
      <button type="button" data-upcoming={item.id === nextId} aria-pressed={item.id === selectedId} onClick={() => choose(item)}>
        <time dateTime={due} className={index ? 'recurring-repeat-date' : undefined}>{Number(due.slice(5, 7))}월 {Number(due.slice(8))}일</time>
        <span className="recurring-timeline-service"><strong>{item.name}</strong>
          <small>{item.status === 'completed' && item.links.length > 0
            ? '결제 ' + new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' })
              .format(new Date(item.links.filter((link) => !link.reversed).at(-1)?.occurred_at ?? item.due_on))
            : item.status === 'skipped' ? '이 달 예정액에서 제외' : recurringDueLabel(date, item.due_on)}</small></span>
        <strong className="recurring-timeline-money">{formatMinor(item.status === 'completed' ? item.actual_minor : item.amount_minor, item.currency)}</strong>
        {statusBadge(item.status)}
      </button></li>)}</ul>
    </li>)}</ol> : <p className="recurring-empty">이 달에 예정된 정기 결제가 없습니다.</p>}
  </div>
}

function Alerts({ items }: { items: RecurringAlert[] }) {
  const router = useRouter()
  const [read, setRead] = useState<string[]>([])
  const unread = items.filter((item) => item.read_at === null && !read.includes(item.id)).length
  async function openAlert(item: RecurringAlert, destination: string) {
    if (!item.read_at && !read.includes(item.id)) {
      const response = await fetch(endpoint, { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read_alert', id: item.id }) }).catch(() => null)
      if (response?.ok) setRead((current) => [...current, item.id])
    }
    router.push(destination)
  }
  return <details className="recurring-alerts">
    <summary>웹 알림 <span>{unread ? '새 알림 ' + unread + '건' : '새 알림 없음'}</span></summary>
    {items.length ? <ul className="recurring-related">{items.map((item) => {
      const destination = href(item.due_on.slice(0, 7), item.service_id, item.occurrence_id)
      return <li key={item.id}><Link href={destination}
        data-draft-guard="true" onNavigate={(event) => {
          event.preventDefault()
          if (canLeaveDraft()) void openAlert(item, destination)
        }}>{item.name} · {alertLabels[item.kind]}</Link><small>{item.due_on}</small></li>
    })}</ul> :
      <p className="recurring-note">표시할 정기 결제 알림이 없습니다.</p>}
  </details>
}

function compareService(a: RecurringService, b: RecurringService, sort: string) {
  if (sort === 'amount') {
    const currency = a.currency.localeCompare(b.currency)
    const difference = BigInt(b.amount_minor) - BigInt(a.amount_minor)
    if (currency || difference) return currency || (difference > 0n ? 1 : -1)
  }
  return Number(a.current_status !== 'active') - Number(b.current_status !== 'active')
    || (a.next_due ?? '9999').localeCompare(b.next_due ?? '9999') || a.name.localeCompare(b.name, 'ko')
}

export default function Workspace({ month, initialService, initialOccurrence }: {
  month: string; initialService: string; initialOccurrence: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const detailAnchor = useRef<HTMLDivElement>(null)
  const tabButtons = useRef<Partial<Record<View, HTMLButtonElement | null>>>({})
  const [data, setData] = useState<RecurringMonth | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [revision, setRevision] = useState(0)
  const [change, setChange] = useState(0)
  const [selected, setSelected] = useState(initialService)
  const [occurrence, setOccurrence] = useState(initialOccurrence)
  const [view, setView] = useState<View>('schedule')
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [serviceState, setServiceState] = useState('')
  const [paymentState, setPaymentState] = useState('')
  const [category, setCategory] = useState('')
  const [account, setAccount] = useState('')
  const [sort, setSort] = useState('due')

  useEffect(() => {
    const controller = new AbortController()
    fetch(endpoint + '?' + new URLSearchParams({ month }), { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (response.status === 401) throw new Error('정기 결제를 관리하려면 인증된 사용자 세션이 필요합니다.')
      if (response.status === 503) throw new Error('Supabase 연결과 정기 결제 마이그레이션을 확인해 주세요.')
      if (!response.ok) throw new Error('정기 결제를 불러오지 못했습니다.')
      const result: RecurringMonth = await response.json()
      if (!controller.signal.aborted) { setData(result); setError('') }
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [month, revision])

  useEffect(() => {
    if (creating && !dialog.current?.open) dialog.current?.showModal()
  }, [creating])

  function revealDetail() {
    requestAnimationFrame(() => {
      const panel = detailAnchor.current
      if (!panel) return
      panel.scrollTop = 0
      if (window.innerWidth <= 760) return
      const { top } = panel.getBoundingClientRect()
      if (top < 0 || top + 96 > window.innerHeight) panel.scrollIntoView({ block: 'start' })
    })
  }

  function choose(id: string, due = '') {
    if ((id !== selected || due !== occurrence) && !canLeaveDraft()) return
    setSelected(id)
    setOccurrence(due)
    if (id) revealDetail()
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    let next: View
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': next = view === 'schedule' ? 'services' : 'schedule'; break
      case 'Home': next = 'schedule'; break
      case 'End': next = 'services'; break
      default: return
    }
    event.preventDefault()
    setView(next)
    tabButtons.current[next]?.focus()
  }

  function refresh(id: string, message: string) {
    setSelected(id)
    setFeedback(message)
    setRevision((value) => value + 1)
    setChange((value) => value + 1)
  }

  const services = data?.services ?? []
  const labels = (idKey: 'category_id' | 'account_id', nameKey: 'category_name' | 'account_name') =>
    [...new Map(services.flatMap((item) => item[idKey] ? [[item[idKey], item[nameKey] ?? '이름 없음'] as const] : [])).entries()]
  const listing = services.filter((service) =>
    service.name.toLocaleLowerCase('ko').includes(search.trim().toLocaleLowerCase('ko'))
    && (!serviceState || service.current_status === serviceState)
    && (!paymentState || service.month_status === paymentState)
    && (!category || category === service.category_id) && (!account || account === service.account_id))
    .sort((a, b) => compareService(a, b, sort))
  const current = services.find((service) => service.id === selected)
  const selectedOccurrences = data?.occurrences.filter((item) => item.service_id === current?.id) ?? []
  const selectedOccurrence = selectedOccurrences.find((item) => item.id === occurrence)
    ?? selectedOccurrences.find((item) => item.status === 'needs_review' || item.status === 'scheduled') ?? selectedOccurrences[0]
  const nextPayment = data?.occurrences.find((item) => item.due_on >= data.today && BigInt(item.remaining_minor) > 0n)
  const prev = month > '1900-01' ? changeMonth(month, -1) : null
  const next = month < '9997-12' ? changeMonth(month, 1) : null
  const guard = (event: { preventDefault(): void }) => { if (!canLeaveDraft()) event.preventDefault() }

  return <>
    <header className="recurring-header">
      <h1>정기 결제</h1>
      <div className="row-actions">
        <div className="recurring-month-nav" aria-label="조회 월">
          {prev && <Link href={href(prev, selected)} aria-label="이전 달" data-draft-guard="true" onNavigate={guard}>‹</Link>}
          <time dateTime={month}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</time>
          {next && <Link href={href(next, selected)} aria-label="다음 달" data-draft-guard="true" onNavigate={guard}>›</Link>}
        </div>
        <button type="button" disabled={!data || Boolean(error)} aria-haspopup="dialog" onClick={() => {
          if (!canLeaveDraft()) return
          setCreating(true)
        }}>새 정기 결제</button>
      </div>
    </header>
    {error ? <section className="panel recurring-empty">
      <p role="alert">{error}</p><button type="button" className="outline" onClick={() => { setError(''); setRevision((value) => value + 1) }}>다시 시도</button>
    </section> : !data ? <p className="recurring-empty" role="status">정기 결제를 불러오는 중입니다.</p> : <>
      <Summary data={data} next={nextPayment} />
      <Alerts key={month + ':' + revision} items={data.alerts} />
      <div className="recurring-workspace-grid">
        <div className="recurring-primary-column">
          <div className="recurring-tabs" role="tablist" aria-label="정기 결제 보기">
            {views.map((item) => <button key={item} ref={(button) => { tabButtons.current[item] = button }}
              type="button" role="tab" id={`recurring-tab-${item}`} aria-controls={`recurring-view-${item}`}
              aria-selected={view === item} tabIndex={view === item ? 0 : -1}
              onClick={() => setView(item)} onKeyDown={navigateTabs}>
              {item === 'schedule' ? '결제 일정' : '전체 서비스'}
            </button>)}
          </div>
          <p className="recurring-feedback" role="status">{feedback}</p>
          <div role="tabpanel" id="recurring-view-schedule" aria-labelledby="recurring-tab-schedule" tabIndex={0} hidden={view !== 'schedule'}>
            <Timeline items={data.occurrences} date={data.today} nextId={nextPayment?.id} selectedId={selectedOccurrence?.id}
              choose={(item) => choose(item.service_id, item.id)} />
          </div>
          <div className="recurring-management" role="tabpanel" id="recurring-view-services" aria-labelledby="recurring-tab-services" tabIndex={0} hidden={view !== 'services'}>
            <div className="recurring-filters">
              <label>서비스 검색<input type="search" value={search} placeholder="서비스명" onChange={(event) => setSearch(event.target.value)} /></label>
              <label>카테고리<select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">전체</option>{labels('category_id', 'category_name').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label>서비스 상태<select value={serviceState} onChange={(event) => setServiceState(event.target.value)}>
                <option value="">전체</option>{Object.entries(serviceStatuses).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label>회차 상태<select value={paymentState} onChange={(event) => setPaymentState(event.target.value)}>
                <option value="">전체</option>{Object.entries(paymentStatuses).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label>결제 수단<select value={account} onChange={(event) => setAccount(event.target.value)}>
                <option value="">전체</option>{labels('account_id', 'account_name').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label>정렬<select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="due">활성·예정일순</option><option value="amount">금액순 (통화별)</option></select></label>
            </div>
            <div className="panel recurring-list table-scroll">
              {listing.length ? <table><thead><tr>
                <th scope="col">서비스</th><th scope="col">결제 수단</th><th scope="col" className="numeric">예상 결제</th><th scope="col">다음 예정일</th><th scope="col">상태</th>
              </tr></thead><tbody>{listing.map((item) => <tr key={item.id} data-selected={selected === item.id}>
                <th scope="row"><button type="button" onClick={() => choose(item.id, selected === item.id ? occurrence : '')} aria-pressed={selected === item.id}>{item.name}</button>
                  <small>{item.category_name ?? '미지정'} · {cycleLabel(item.cycle_unit, item.cycle_count)}</small></th>
                <td className="recurring-list-account">{item.account_name ?? '미지정'}</td>
                <td className="numeric">{formatMinor(item.amount_minor, item.currency)}</td>
                <td className="recurring-list-date">{item.next_due ? <time dateTime={item.next_due}>{item.next_due}</time> : '—'}</td>
                <td><span className="recurring-list-status"><span>{serviceStatuses[item.current_status]}</span>{item.month_status && statusBadge(item.month_status)}</span></td>
              </tr>)}</tbody></table> :
                <p className="recurring-empty">{services.length ? '조건에 맞는 서비스가 없습니다.' : '등록한 정기 결제가 없습니다.'}</p>}
            </div>
          </div>
        </div>
        <div ref={detailAnchor} className="recurring-detail-slot" data-selected={Boolean(current && !creating)}>
          {!creating && current && <button type="button" className="outline recurring-mobile-close" onClick={() => choose('')}>상세 닫기</button>}
          {!creating && current ? <ServiceDetail key={current.id} service={current}
            occurrences={selectedOccurrences} item={selectedOccurrence} date={data.today} revision={change}
            onOccurrence={setOccurrence} onChanged={(id) => refresh(id, '정기 결제를 저장했습니다.')} /> :
            <section className="panel recurring-detail"><h3>서비스 상세</h3><p className="recurring-note">목록 또는 일정에서 서비스를 선택하세요.</p></section>}
        </div>
      </div>
    </>}
    <dialog className="recurring-dialog" ref={dialog} aria-labelledby="recurring-create-title"
      onCancel={(event) => { if (!canLeaveDraft()) event.preventDefault() }} onClose={() => setCreating(false)}>
      <h2 id="recurring-create-title">새 정기 결제</h2>
      {creating && data && <ServiceForm date={data.today} onClose={() => dialog.current?.close()} onSaved={(id) => {
        dialog.current?.close()
        setOccurrence('')
        refresh(id, '정기 결제를 등록했습니다.')
        revealDetail()
      }} />}
    </dialog>
  </>
}
