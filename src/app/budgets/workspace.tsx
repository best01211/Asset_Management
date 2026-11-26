'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { analyzeBudget, budgetPercent, budgetWon, isBudgetMonth } from '@/lib/monthly-budget'
import type { BudgetAnalysis, BudgetCategory, BudgetWorkspaceData } from '@/lib/monthly-budget'
import { changeMonth } from '@/lib/recurring-payments'
import { canLeaveDraft } from '../transactions/draft'
import { BudgetChart, BudgetComparison, BudgetForecastBasis, BudgetInsights, BudgetRisk, categoryComparison, statusNames } from './analytics'
import { BudgetSettings, CategoryEditor } from './editors'
import type { SaveBudget } from './editors'

const amount = (value: bigint | null) => value === null ? '—' : budgetWon(value)
const balance = (value: bigint | null) => value === null ? '—' : value < 0n ? '초과 ' + budgetWon(-value) : budgetWon(value)
const byMonth = (month: string) => '/budgets?' + new URLSearchParams({ month })
const budgetTabs = [
  { id: 'overview', label: '예산 현황' },
  { id: 'analysis', label: '소비 분석' },
  { id: 'comparison', label: '전월 비교' },
] as const
type BudgetTab = typeof budgetTabs[number]['id']

function BudgetSummary({ analysis }: { analysis: BudgetAnalysis }) {
  const { target, spent, pendingWon, projected, remaining, active, closed, foreign } = analysis
  return <section className="budget-overview" aria-label="월 예산 요약">
    <div className="budget-hero-panel">
      <div><h2>{active ? '이번 달 실제 남은 예산' : '조회 월 실제 남은 예산'}</h2>
        <p className="budget-main-amount" data-negative={remaining !== null && remaining < 0n}>{remaining === null ? '—' : balance(remaining)}</p>
        <p>{target === null ? '월 목표 예산을 설정해 주세요.' : foreign ? '미결제 외화 회차의 환산 기준이 필요합니다.' : '확정 지출과 미결제 정기 결제를 반영한 예산'}</p></div>
      <dl><div><dt>월 목표 예산</dt><dd>{amount(target)}</dd></div><div><dt>확정 지출</dt><dd>{amount(spent)}</dd></div>
        <div><dt>미결제 정기 결제</dt><dd>{amount(pendingWon)}{foreign && ' + 외화'}</dd></div></dl>
    </div>
    <div className="budget-forecast">
      <h2>{closed ? '월말 확정 지출' : '월말 예상 총지출'}</h2>
      <p className="budget-forecast-amount">{amount(closed ? spent : projected)}</p>
      {closed ? <p className="budget-note">종료된 달의 확정 순지출입니다.</p>
        : projected === null ? <p className="budget-note">{foreign ? '미결제 외화 회차의 환산 기준이 필요합니다.' : '예측할 데이터가 부족합니다.'}</p>
          : target !== null && <p className="budget-note">{projected > target ? '예산 초과 예상 ' + budgetWon(projected - target) : '예산 여유 예상 ' + budgetWon(target - projected)}</p>}
    </div>
  </section>
}

function CategoryRows({ categories, selected, choose }: { categories: BudgetCategory[]; selected?: string; choose: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const rows = categories.filter((item) => item.name.toLocaleLowerCase('ko').includes(search.trim().toLocaleLowerCase('ko')))
  return <div className="budget-category-list">
    {categories.length > 0 && <label className="budget-category-search">카테고리 찾기<input type="search" placeholder="카테고리명" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
    {rows.length ? <ul>{rows.map((item) => {
      const progress = item.usage === null ? item.status === 'over' ? 1000 : 0 : Number(item.usage < 0n ? 0n : item.usage > 1000n ? 1000n : item.usage)
      return <li key={item.category_id}><button type="button" aria-pressed={item.category_id === selected} onClick={() => choose(item.category_id)}>
        <span className="budget-row-title"><strong>{item.name}</strong><span className="budget-status" data-tone={item.status}>{statusNames[item.status]}</span></span>
        <span className="budget-row-values"><span>예산 <strong>{amount(item.limit)}</strong></span><span>확정 <strong>{amount(item.actual)}</strong></span>
          <span>{item.balance !== null && item.balance < 0n ? '초과' : '잔여'} <strong>{amount(item.balance === null ? null : item.balance < 0n ? -item.balance : item.balance)}</strong></span></span>
        <span className="budget-row-progress"><progress aria-label={`${item.name} 예산 사용률`} value={progress} max="1000" data-tone={item.status} />
          <span>{item.usage === null ? '—' : budgetPercent(item.usage)}</span></span>
      </button></li>
    })}</ul> : <p className="budget-empty">{categories.length ? '검색 조건에 맞는 카테고리가 없습니다.' : '원화 지출 카테고리가 없습니다.'}</p>}
  </div>
}

function CategoryDetail({ item, month, active, closed, editing, setEditing, save }: {
  item: BudgetCategory; month: string; active: boolean; closed: boolean; editing: boolean; setEditing: (value: boolean) => void; save: SaveBudget
}) {
  return <section className="budget-category-detail" aria-labelledby="budget-category-title">
    <div className="budget-section-heading"><div><h3 id="budget-category-title">{item.name}</h3><span className="budget-status" data-tone={item.status}>{statusNames[item.status]}</span></div>
      {!editing && <button type="button" className="outline" onClick={() => setEditing(true)}>예산 수정</button>}</div>
    <dl className="budget-detail-numbers"><div><dt>목표 예산</dt><dd>{amount(item.limit)}</dd></div><div><dt>확정 지출</dt><dd>{amount(item.actual)}</dd></div>
      <div><dt>남은 예산</dt><dd>{balance(item.balance)}</dd></div><div><dt>사용률</dt><dd>{item.usage === null ? '—' : budgetPercent(item.usage)}</dd></div>
      <div><dt>{closed ? '월말 확정 지출' : '월말 예상 지출'}</dt><dd>{closed ? amount(item.actual) : item.projected === null ? '예측 불가' : amount(item.projected)}</dd></div>
      <div><dt>{active ? '지난달 동기간 대비' : '직전 월 대비'}</dt><dd>{categoryComparison(item)}</dd></div></dl>
    {editing && <CategoryEditor category={item} save={save} close={() => setEditing(false)} />}
    <Link className="budget-link" href={'/transactions?' + new URLSearchParams({ mode: 'connected', month, category: item.category_id })}>관련 거래 보기</Link>
  </section>
}

export default function BudgetWorkspace({ month }: { month: string }) {
  const router = useRouter()
  const detail = useRef<HTMLDivElement>(null)
  const tabButtons = useRef<Partial<Record<BudgetTab, HTMLButtonElement | null>>>({})
  const [data, setData] = useState<BudgetWorkspaceData | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selection, setSelection] = useState('')
  const [settings, setSettings] = useState(false)
  const [editing, setEditing] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [tab, setTab] = useState<BudgetTab>('overview')

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/budgets?' + new URLSearchParams({ month }), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) throw new Error('월별 예산을 보려면 인증된 사용자 세션이 필요합니다.')
        if (response.status === 503) throw new Error('Supabase 연결이 설정되지 않았습니다.')
        if (!response.ok) throw new Error('월별 예산을 불러오지 못했습니다. 연결과 데이터베이스 반영 상태를 확인해 주세요.')
        const result: BudgetWorkspaceData = await response.json()
        if (!controller.signal.aborted) { setData(result); setError('') }
      }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [month, revision])

  const save: SaveBudget = async (changes) => {
    try {
      const response = await fetch('/api/budgets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, changes }) })
      if (response.status === 409) return '다른 곳에서 예산이 변경되었습니다. 입력을 확인한 뒤 화면을 다시 불러와 주세요.'
      if (response.status === 400) return '예산 금액을 확인해 주세요.'
      if (!response.ok) return '예산을 저장하지 못했습니다.'
      const totalChange = changes.find((change) => change.category_id === null)
      setData((current) => current && ({ ...current, total: totalChange
        ? { amount_minor: totalChange.amount_minor, version: totalChange.expected_version + 1 } : current.total,
        categories: current.categories.map((item) => {
          const updated = changes.find((change) => change.category_id === item.category_id)
          return updated ? { ...item, amount_minor: updated.amount_minor, version: updated.expected_version + 1 } : item
        }),
      }))
      setNotice('예산을 저장했습니다.')
      setRevision((value) => value + 1)
      return null
    } catch { return '저장 결과를 확인하지 못했습니다. 다시 조회해 주세요.' }
  }

  const analysis = data ? analyzeBudget(data) : null
  const selected = analysis?.categories.find((item) => item.category_id === selection) ?? analysis?.categories[0]

  function activateTab(next: BudgetTab) {
    if (next === tab) return
    if (!canLeaveDraft()) {
      tabButtons.current[tab]?.focus()
      return
    }
    setEditing(false)
    setMobileDetail(false)
    setTab(next)
    tabButtons.current[next]?.focus()
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
    const current = budgetTabs.findIndex((item) => item.id === tab)
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (current + budgetTabs.length - 1) % budgetTabs.length; break
      case 'ArrowRight': next = (current + 1) % budgetTabs.length; break
      case 'Home': next = 0; break
      case 'End': next = budgetTabs.length - 1; break
      default: return
    }
    event.preventDefault()
    activateTab(budgetTabs[next].id)
  }

  function choose(id: string) {
    if (selected?.category_id !== id && !canLeaveDraft()) return
    if (selected?.category_id !== id) setEditing(false)
    setSelection(id)
    setMobileDetail(true)
    if (window.innerWidth > 900) requestAnimationFrame(() => {
      const top = detail.current?.getBoundingClientRect().top
      if (top !== undefined && (top < 0 || top + 96 > window.innerHeight)) detail.current?.scrollIntoView({ block: 'start' })
    })
  }

  const earlier = month > '1900-01' ? changeMonth(month, -1) : null
  const later = month < '9998-12' ? changeMonth(month, 1) : null
  const panels = data && analysis ? {
    overview: <>
      <section className="budget-section" aria-labelledby="budget-categories"><h2 id="budget-categories">카테고리별 예산</h2>
        <div className="budget-category-grid"><CategoryRows categories={analysis.categories} selected={selected?.category_id} choose={choose} />
          {selected && <div className="budget-detail-slot" data-open={mobileDetail && !settings} ref={detail}>
            <button type="button" className="outline budget-detail-close" onClick={() => {
              if (canLeaveDraft()) { setEditing(false); setMobileDetail(false) }
            }}>상세 닫기</button>
            <CategoryDetail key={selected.category_id} item={selected} month={month} active={analysis.active} closed={analysis.closed}
              editing={editing} setEditing={setEditing} save={save} />
          </div>}
        </div>
      </section>
      <BudgetRisk data={data} analysis={analysis} choose={choose} />
    </>,
    analysis: <div className="budget-analysis-grid">
      <section className="budget-section" aria-labelledby="budget-chart-title"><h2 id="budget-chart-title">소비 추이</h2><BudgetChart chart={analysis.chart} /></section>
      <div className="budget-analysis-notes"><BudgetForecastBasis data={data} analysis={analysis} /><BudgetInsights data={data} analysis={analysis} /></div>
    </div>,
    comparison: <BudgetComparison data={data} analysis={analysis} />,
  } : null

  return <>
    <header className="budget-page-header"><h1>월별 예산</h1>
      <div className="row-actions"><div className="budget-month" aria-label="조회 월">
        {earlier && <Link href={byMonth(earlier)} aria-label="이전 달">‹</Link>}
        <input type="month" aria-label="조회 월" min="1900-01" max="9998-12" value={month} onChange={(event) => {
          if (isBudgetMonth(event.target.value) && canLeaveDraft()) router.push(byMonth(event.target.value))
        }} />{later && <Link href={byMonth(later)} aria-label="다음 달">›</Link>}
      </div><button type="button" aria-haspopup="dialog" disabled={!data || Boolean(error)} onClick={() => {
        if (canLeaveDraft()) { setEditing(false); setSettings(true) }
      }}>전체 예산 설정</button></div>
    </header>
    <p className="budget-feedback" role="status">{notice}</p>
    {analysis && <BudgetSummary analysis={analysis} />}
    <div className="budget-tabs" role="tablist" aria-label="월별 예산 보기">
      {budgetTabs.map(({ id, label }) => <button ref={(button) => { tabButtons.current[id] = button }} key={id} type="button" role="tab"
        id={`budget-tab-${id}`} aria-controls={`budget-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        onClick={() => activateTab(id)} onKeyDown={navigateTabs}>{label}</button>)}
    </div>
    {budgetTabs.map(({ id }) => <div className="budget-tab-panel" key={id} role="tabpanel" id={`budget-panel-${id}`}
      aria-labelledby={`budget-tab-${id}`} tabIndex={0} hidden={tab !== id} aria-busy={!error && !data}>
      {tab === id && error && <div className="budget-empty"><p role="alert">{error}</p><button type="button" className="outline" onClick={() => {
        setError('')
        setRevision((value) => value + 1)
      }}>다시 시도</button></div>}
      {tab === id && !error && !data && <p className="budget-empty" role="status">월별 예산을 불러오는 중입니다.</p>}
      {panels?.[id]}
    </div>)}
    {settings && data && <BudgetSettings data={data} save={save} close={() => setSettings(false)} />}
  </>
}
