'use client'

import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { amountWithin, defaultRange, formatMinor, kindLabels, transactionType, validRange } from '@/lib/transaction-history'
import type { Annotation, HistoryData, HistoryRow, Option } from '@/lib/transaction-history'
import { readDemoFinance } from '@/lib/local-finance'
import { canLeaveDraft } from './draft'
import HistoryDetail from './history-detail'

const types = { income: '수입', expense: '지출', transfer: '이체', other: '환불·정정·조정' }
const sorts = { newest: '최신순', oldest: '과거순', amount: '금액순 (통화별)' }
const pageSize = 10
const seoulTime = new Intl.DateTimeFormat('ko-KR', { timeStyle: 'short', timeZone: 'Asia/Seoul' })
function amountOrder(a: string, b: string) {
  const scaled = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(6, '0'))
  }
  const delta = scaled(a) - scaled(b)
  return delta > 0n ? 1 : delta < 0n ? -1 : 0
}
const names = (options: Option[]) => options.map((item) => item.name).join(' · ') || '—'
const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
const options = (rows: HistoryRow[], key: 'categories' | 'accounts') =>
  [...new Map(rows.flatMap((row) => row[key]).map((item) => [item.id, item])).values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'))

function demoHistory(from: string, to: string): HistoryData {
  const data = readDemoFinance(localStorage)
  const month = defaultRange().from.slice(0, 7)
  const confirmed = data.purchases.filter((item) => item.status === 'approved')
  const monthly = confirmed.filter((item) => item.date.startsWith(month))
  const spent = monthly.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString()
  return {
    annotations: true,
    summary: { month, count: monthly.length, expense: spent, income: '0', net: spent },
    rows: confirmed.filter((item) => item.date >= from && item.date <= to).map((item) => ({
      id: item.id, name: item.merchant, date: item.date, amount: String(item.amount), currency: 'KRW',
      kind: 'purchase_cash', categories: data.categories.filter((category) => category.id === item.categoryId),
      accounts: data.accounts.filter((account) => account.id === item.accountId), source: '샘플 거래',
      annotation: data.annotations?.[item.id],
    })),
  }
}

function rowAmount(row: HistoryRow) {
  const type = transactionType(row.kind)
  const sign = row.reversed ? '' : type === 'expense' ? '−' : type === 'income' || row.kind === 'purchase_refund' ? '+' : ''
  return sign + formatMinor(row.amount, row.currency)
}

function TransactionTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null
  const remaining = tags.slice(2)
  return <ul className="transaction-row-tags" aria-label="태그">
    {tags.slice(0, 2).map((tag, index) => <li key={index} title={tag}>{tag}</li>)}
    {remaining.length > 0 && <li title={remaining.join(' · ')} aria-label={'태그 ' + remaining.length + '개 더 있음'}>+{remaining.length}</li>}
  </ul>
}

export default function HistoryWorkspace({ demo, range, category: initialCategory, tabs }: {
  demo: boolean; range: { from: string; to: string }; category: string; tabs?: ReactNode
}) {
  const [result, setResult] = useState<HistoryData | null>(null)
  const [period, setPeriod] = useState(range)
  const [error, setError] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [category, setCategory] = useState(initialCategory)
  const [account, setAccount] = useState('')
  const [amounts, setAmounts] = useState({ min: '', max: '' })
  const [sort, setSort] = useState<keyof typeof sorts>('newest')
  const [checked, setChecked] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState(0)
  const [saved, setSaved] = useState<Record<string, Annotation>>({})
  const [detailVersion, setDetailVersion] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        if (demo) {
          setResult(demoHistory(period.from, period.to))
          return
        }
        const response = await fetch('/api/transactions?' + new URLSearchParams(period), { signal: controller.signal, cache: 'no-store' })
        if (response.status === 401) throw new Error('거래 내역을 보려면 인증된 사용자 세션이 필요합니다.')
        if (!response.ok) throw new Error('확정 거래를 불러오지 못했습니다.')
        const data: HistoryData = await response.json()
        if (!controller.signal.aborted) setResult(data)
      } catch (problem) {
        if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : '거래 목록을 불러오지 못했습니다.')
      }
    }
    queueMicrotask(() => { if (!controller.signal.aborted) void load() })
    return () => controller.abort()
  }, [demo, period, revision])

  const all = result?.rows ?? []
  const categories = options(all, 'categories')
  const accounts = options(all, 'accounts')
  const needle = search.trim().toLocaleLowerCase('ko')
  const filtered = all.filter((row) => (!needle || [row.name, (saved[row.id] ?? row.annotation)?.memo ?? '', ...(saved[row.id] ?? row.annotation)?.tags ?? []]
    .some((item) => item.toLocaleLowerCase('ko').includes(needle)))
    && (!type || transactionType(row.kind) === type)
    && (!category || row.categories.some((item) => item.id === category))
    && (!account || row.accounts.some((item) => item.id === account))
    && amountWithin(row.amount, row.currency, amounts.min, amounts.max))
    .sort((a, b) => {
      const dateDifference = Date.parse(b.date) - Date.parse(a.date) || b.date.localeCompare(a.date) || b.id.localeCompare(a.id)
      if (sort === 'oldest') return -dateDifference
      if (sort !== 'amount') return dateDifference
      return a.currency.localeCompare(b.currency) || (BigInt(a.amount) === BigInt(b.amount) ? dateDifference : BigInt(a.amount) > BigInt(b.amount) ? -1 : 1)
    })
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageStart = currentPage * pageSize
  const visible = filtered.slice(pageStart, pageStart + pageSize)
  const selectedRow = all.find((row) => row.id === selected)
  const summary = result?.summary
  const resetPage = () => { setPage(0); setChecked([]) }

  function loadPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = new FormData(event.currentTarget)
    const from = String(input.get('from'))
    const to = String(input.get('to'))
    const min = String(input.get('minimum')).trim()
    const max = String(input.get('maximum')).trim()
    const amountPattern = /^\d{1,19}(?:\.\d{1,6})?$/
    if (!validRange(from, to)) { setRangeError('조회 기간은 시작일부터 최대 366일입니다.'); return }
    if ((min && !amountPattern.test(min)) || (max && !amountPattern.test(max)) || (min && max && amountOrder(min, max) > 0)) {
      setRangeError('최소·최대 금액을 확인해 주세요.')
      return
    }
    if (period.from !== from || period.to !== to) {
      if (!canLeaveDraft()) return
      setSelected('')
      setResult(null)
      setError('')
      setPeriod({ from, to })
    }
    setRangeError('')
    setAmounts({ min, max })
    resetPage()
    setDetailsOpen(false)
  }

  function selectRow(id: string) {
    if (id !== selected && canLeaveDraft()) setSelected(id)
  }

  function changePage(next: number) {
    if (selected && !canLeaveDraft()) return
    setSelected('')
    setPage(next)
  }

  function changeAnnotation(id: string, annotation: Annotation) {
    setSaved((current) => ({ ...current, [id]: annotation }))
    setDetailVersion((value) => value + 1)
  }

  const current = defaultRange()
  const chips = [
    search && { label: '검색 ' + search, clear: () => setSearch('') },
    type && { label: types[type as keyof typeof types], clear: () => setType('') },
    category && { label: categories.find((item) => item.id === category)?.name ?? '카테고리', clear: () => setCategory('') },
    account && { label: accounts.find((item) => item.id === account)?.name ?? '계좌', clear: () => setAccount('') },
    (amounts.min || amounts.max) && { label: '금액 ' + (amounts.min || '0') + ' ~ ' + (amounts.max || '제한 없음'), clear: () => setAmounts({ min: '', max: '' }) },
    (period.from !== current.from || period.to !== current.to) && { label: period.from + ' ~ ' + period.to, clear: () => {
      if (!canLeaveDraft()) return
      setSelected(''); setResult(null); setError(''); setPeriod(current)
    }},
  ]

  return <>
    <section className="transaction-summary" aria-label="이번 달 거래 요약">
      <div className="transaction-summary-title"><h2>이번 달 거래 요약</h2><time dateTime={(summary?.month ?? current.from.slice(0, 7))}>{summary?.month ?? current.from.slice(0, 7)}</time></div>
      <dl>{[
        ['총수입', summary?.income], ['총지출', summary?.expense], ['순지출', summary?.net],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null ? '—' : formatMinor(value, 'KRW')}</dd></div>)}
        <div><dt>확정 거래</dt><dd>{summary ? summary.count + '건' : '—'}</dd></div></dl>
      <p>금액은 원화 원장 기준입니다. 순지출은 구매와 이체 수수료에서 환불을 뺀 금액입니다.</p>
    </section>
    {tabs}
    <div className="transaction-toolbar">
      <label className="transaction-search">검색<input type="search" value={search} placeholder="거래명·가맹점·메모·태그" onChange={(event) => { setSearch(event.target.value); resetPage() }} /></label>
      <label>거래 유형<select value={type} onChange={(event) => { setType(event.target.value); resetPage() }}>
        <option value="">전체 유형</option>{Object.entries(types).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>카테고리<select value={category} onChange={(event) => { setCategory(event.target.value); resetPage() }}>
        <option value="">전체 카테고리</option>{category && !categories.some((item) => item.id === category) && <option value={category}>선택한 카테고리</option>}
        {categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>정렬<select value={sort} onChange={(event) => { setSort(event.target.value as keyof typeof sorts); resetPage() }}>
        {Object.entries(sorts).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <button type="button" className="outline" aria-expanded={detailsOpen} aria-controls="transaction-extra-filters" onClick={() => setDetailsOpen(!detailsOpen)}>상세 필터</button>
    </div>
    {detailsOpen && <form id="transaction-extra-filters" className="transaction-extra" onSubmit={loadPeriod}>
      <label>계좌·카드<select value={account} onChange={(event) => { setAccount(event.target.value); resetPage() }}>
        <option value="">전체 계좌·카드</option>{account && !accounts.some((item) => item.id === account) && <option value={account}>선택한 계좌</option>}
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>시작일<input name="from" type="date" defaultValue={period.from} required /></label>
      <label>종료일<input name="to" type="date" defaultValue={period.to} required /></label>
      <label>최소 금액<input name="minimum" inputMode="decimal" defaultValue={amounts.min} /></label>
      <label>최대 금액<input name="maximum" inputMode="decimal" defaultValue={amounts.max} /></label>
      <button type="submit">필터 적용</button>
      {rangeError && <p role="alert">{rangeError}</p>}
    </form>}
    {chips.some(Boolean) && <div className="transaction-chips" aria-label="적용된 필터">{chips.map((chip, index) => chip &&
      <button type="button" className="outline" key={index} aria-label={chip.label + ' 필터 해제'} onClick={() => { chip.clear(); resetPage() }}>{chip.label} <span aria-hidden="true">×</span></button>)}</div>}
    <div className={selectedRow ? 'history-grid history-grid-with-detail' : 'history-grid'}>
      <section className="transaction-list panel" aria-labelledby="confirmed-transactions" aria-busy={!result && !error}>
        <div className="transaction-list-heading">
          <div><h2 id="confirmed-transactions">확정 거래 내역</h2>
            <p className="transaction-list-period">{period.from === current.from && period.to === current.to && '이번 달 · '}
              <time dateTime={period.from}>{period.from}</time> ~ <time dateTime={period.to}>{period.to}</time></p></div>
          {result && <small>{checked.length ? checked.length + '건 선택 · ' : ''}{filtered.length}건</small>}
        </div>
        {error ? <div className="transaction-empty"><p role="alert">{error}</p><button type="button" className="outline" onClick={() => { setError(''); setRevision((value) => value + 1) }}>다시 시도</button></div> :
          !result ? <p className="transaction-empty" role="status">거래를 불러오는 중입니다.</p> :
          !visible.length ? <p className="transaction-empty">{filtered.length || search || chips.some(Boolean) ? '조건에 맞는 거래가 없습니다.' : '조회 기간에 확정 거래가 없습니다.'}</p> :
            <div className="table-scroll"><table>
              <thead><tr><th scope="col"><span className="home-visually-hidden">선택</span></th><th scope="col">거래일시</th><th scope="col">거래명</th>
                <th scope="col" className="transaction-secondary">카테고리</th><th scope="col" className="transaction-secondary">결제 수단</th><th scope="col" className="transaction-secondary">거래 유형</th>
                <th scope="col" className="numeric">금액</th><th scope="col"><span className="home-visually-hidden">상세</span></th></tr></thead>
              <tbody>{visible.map((row) => <tr key={row.id} data-selected={row.id === selected || checked.includes(row.id)}>
                <td><input type="checkbox" aria-label={row.name + ' 선택'} checked={checked.includes(row.id)} onChange={(event) => {
                  setChecked((list) => event.target.checked ? [...list, row.id] : list.filter((id) => id !== row.id))
                }} /></td>
                <td><time dateTime={row.date}>{row.date.length === 10 ? row.date : seoulDate.format(new Date(row.date))}</time>
                  {row.date.length > 10 && <small>{seoulTime.format(new Date(row.date))}</small>}</td>
                <th scope="row"><button type="button" className="transaction-name" onClick={() => selectRow(row.id)}>{row.name}</button>
                  {row.reversed && <small>정정됨</small>}
                  <TransactionTags tags={(saved[row.id] ?? row.annotation)?.tags} />
                </th>
                <td className="transaction-secondary">{names(row.categories)}</td>
                <td className="transaction-secondary">{names(row.accounts)}{row.payment && <small>{row.payment}</small>}</td>
                <td className="transaction-secondary">{kindLabels[row.kind] ?? '기타'}</td>
                <td className="numeric transaction-amount" data-income={row.kind === 'income'}>{rowAmount(row)}</td>
                <td><button className="transaction-row-link" type="button" aria-label={row.name + ' 상세'} aria-pressed={row.id === selected} onClick={() => selectRow(row.id)}>›</button></td>
              </tr>)}</tbody>
            </table></div>}
        {pageCount > 1 && <nav className="transaction-pagination" aria-label="확정 거래 내역 페이지">
          <button type="button" className="outline" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>이전</button>
          <span role="status">{currentPage + 1} / {pageCount} 페이지 <small>{pageStart + 1}–{pageStart + visible.length} / {filtered.length}건</small></span>
          <button type="button" className="outline" disabled={currentPage + 1 === pageCount} onClick={() => changePage(currentPage + 1)}>다음</button>
        </nav>}
      </section>
      {selectedRow ? <HistoryDetail key={selectedRow.id} row={selectedRow} annotation={saved[selectedRow.id] ?? selectedRow.annotation}
        annotations={Boolean(result?.annotations)} revision={detailVersion} demo={demo}
        onSave={(annotation) => changeAnnotation(selectedRow.id, annotation)}
        onCategoryChange={() => { setRevision((value) => value + 1); setDetailVersion((value) => value + 1) }}
        onClose={() => selectRow('')} /> : null}
    </div>
  </>
}
