'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { accountBalance, amount, demoFinance, demoRecoveryEvents, readDemoFinance, storageKey, today } from '@/lib/local-finance'
import type { Account, Finance, Purchase } from '@/lib/local-finance'
import DemoAssetChart from './demo-asset-chart'
import { EditorialHome, RecurringPayments, ReviewPanel, homeWon } from './editorial-home'
import { BudgetSummary, CategorySpending, HomeSource } from './home-summary'
import SettingsWindow from './settings-window'
import './dashboard.css'

const currency = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' })
const won = (value: number) => currency.format(value)
const total = (purchases: Purchase[]) => purchases.reduce((sum, purchase) => sum + purchase.amount, 0)
type DemoPage = 'overview' | 'transactions' | 'budgets' | 'accounts'
const sections = [
  { id: 'overview', label: '금융 현황', mark: '◫', href: '#overview' },
  { id: 'transactions', label: '거래', mark: '≡', href: '/transactions?mode=demo' },
  { id: 'budgets', label: '예산', mark: '◔', href: '/demo/budgets' },
  { id: 'recurring', label: '정기 결제', mark: '↻', href: '/recurring-payments' },
  { id: 'accounts', label: '계좌·카드', mark: '▣', href: '/demo/accounts' },
  { id: 'investments', label: '투자·외화', mark: '↗', href: '/investments?mode=demo' },
  { id: 'reports', label: '결산·보고서', mark: '▤', href: '/ledger-summary' },
]

export default function Dashboard({ page = 'overview', embedded = false, initialReviewId }: {
  page?: DemoPage; embedded?: boolean; initialReviewId?: string
}) {
  const reviewPage = page === 'transactions'
  const [finance, setFinance] = useState<Finance | null>(null)
  const [notice, setNotice] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const [menuOpen, setMenuOpen] = useState(true)
  const [editing, setEditing] = useState<Purchase | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')

  useEffect(() => {
    try {
      const loaded = readDemoFinance(localStorage)
      // Browser storage is first available after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFinance(loaded)
      if (initialReviewId) {
        const purchase = loaded.purchases.find((item) => item.id === initialReviewId && item.status === 'pending')
        if (purchase) setEditing(purchase)
        else setNotice('해당 거래의 검토가 이미 끝났거나 거래를 찾을 수 없습니다.')
      }
    } catch {
      setFinance(demoFinance())
      setStorageWarning('이 브라우저의 저장 데이터를 읽을 수 없습니다.')
    }
    if (page === 'overview') {
      const section = window.location.hash.slice(1)
      if (section === 'transactions' || section === 'purchase-form') {
        window.location.replace('/transactions?mode=demo&tab=review' + (section === 'purchase-form' ? '#purchase-form' : ''))
      } else if (section === 'budgets' || section === 'accounts') {
        window.location.replace('/demo/' + section)
      }
    }
  }, [page, initialReviewId])

  useEffect(() => {
    if (!finance || storageWarning) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(finance))
      window.dispatchEvent(new Event('finance:demo-change'))
    } catch {
      // Surface a failure reported by the browser storage write.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStorageWarning('브라우저에 변경 사항을 저장하지 못했습니다.')
    }
  }, [finance, storageWarning])

  if (!finance) return <main className="loading">금융 대시보드를 불러오는 중입니다.</main>
  const data = finance
  const todayDate = today()
  const month = todayDate.slice(0, 7)
  const approved = data.purchases.filter((purchase) => purchase.status === 'approved')
  const pending = data.purchases.filter((purchase) => purchase.status === 'pending')
  const approvedThisMonth = approved.filter((purchase) => purchase.date.startsWith(month))
  const balances = data.accounts.map((account) => ({
    ...account, balance: accountBalance(account, approved.filter((purchase) => purchase.date <= todayDate)),
  }))
  const budget = data.categories.reduce((sum, category) => sum + category.budget, 0)
  const spent = total(approvedThisMonth)
  const approvedIds = new Set(approved.map((purchase) => purchase.id))
  const remainingPayments = (data.recurring ?? [])
    .filter((item) => item.due.startsWith(month) && (!item.purchaseId || !approvedIds.has(item.purchaseId)))
    .sort((left, right) => left.due.localeCompare(right.due) || left.name.localeCompare(right.name, 'ko'))
  const scheduled = remainingPayments.reduce((sum, item) => sum + item.amount, 0)
  const categoryTotals = new Map<string, number>()
  for (const purchase of approvedThisMonth) {
    categoryTotals.set(purchase.categoryId, (categoryTotals.get(purchase.categoryId) ?? 0) + purchase.amount)
  }
  const categorySpending = data.categories.filter((item) => categoryTotals.has(item.id)).map((item) => ({
    id: item.id, name: item.name, amount: BigInt(categoryTotals.get(item.id) ?? 0),
    href: '/transactions?' + new URLSearchParams({ mode: 'demo', category: item.id, month }),
  }))
  const recentPending = [...pending].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 3)
  const recoveryCount = (data.recoveryEvents ?? demoRecoveryEvents()).filter((event) => event.status === 'parse_failed').length
  const visible = pending
    .filter((purchase) => (!category || purchase.categoryId === category)
      && purchase.merchant.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => right.date.localeCompare(left.date))

  function savePurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const merchant = String(values.get('merchant') ?? '').trim()
    const date = String(values.get('date') ?? '')
    const paid = amount(values.get('amount'), 1)
    const accountId = String(values.get('accountId') ?? '')
    const categoryId = String(values.get('categoryId') ?? '')
    if (!merchant || merchant.length > 80 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || paid === null
      || !data.accounts.some((account) => account.id === accountId)
      || !data.categories.some((category) => category.id === categoryId)) {
      setNotice('거래 정보를 확인해 주세요.')
      return
    }
    const purchase: Purchase = {
      id: editing?.id ?? crypto.randomUUID(), merchant, date, amount: paid, accountId, categoryId, status: 'pending',
    }
    setFinance((current) => current && ({
      ...current,
      purchases: editing
        ? current.purchases.map((item) => item.id === editing.id && item.status === 'pending' ? purchase : item)
        : [purchase, ...current.purchases],
    }))
    if (!editing) form.reset()
    setEditing(null)
    setNotice(editing ? '대기 거래를 수정했습니다.' : '거래를 검토 대기에 추가했습니다.')
  }

  function approve(ids: string[]) {
    const valid = new Set(pending.filter((purchase) => ids.includes(purchase.id)).map((purchase) => purchase.id))
    if (!valid.size) return
    setFinance((current) => current && ({
      ...current,
      purchases: current.purchases.map((purchase) => purchase.status === 'pending' && valid.has(purchase.id)
        ? { ...purchase, status: 'approved' } : purchase),
    }))
    setSelected((current) => current.filter((id) => !valid.has(id)))
    if (editing && valid.has(editing.id)) setEditing(null)
    setNotice(`${valid.size}건을 확정했습니다.`)
  }

  function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const name = String(values.get('name') ?? '').trim()
    const kind = values.get('kind')
    const opening = amount(values.get('opening'))
    if (!name || opening === null || (kind !== 'asset' && kind !== 'credit')) {
      setNotice('계좌 이름과 초기 잔액을 확인해 주세요.')
      return
    }
    const account: Account = { id: crypto.randomUUID(), name, kind, opening, openedOn: todayDate }
    setFinance((current) => current && ({ ...current, accounts: [...current.accounts, account] }))
    form.reset()
    setNotice('계좌를 추가했습니다.')
  }

  function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const name = String(values.get('name') ?? '').trim()
    const limit = amount(values.get('budget'))
    if (!name || limit === null) {
      setNotice('카테고리 이름과 예산을 확인해 주세요.')
      return
    }
    const existing = data.categories.find((category) => category.name === name)
    const category = { id: existing?.id ?? crypto.randomUUID(), name, budget: limit }
    setFinance((current) => current && ({
      ...current,
      categories: existing
        ? current.categories.map((item) => item.id === existing.id ? category : item)
        : [...current.categories, category],
    }))
    form.reset()
    setNotice(existing ? '월 예산을 변경했습니다.' : '카테고리와 월 예산을 추가했습니다.')
  }

  const content = <>
    {page === 'overview' && <section id="overview" aria-labelledby="overview-title">
      <div className="section-heading demo-heading">
        <h1 id="overview-title">금융 현황</h1>
        <div className="home-heading-meta"><time className="demo-current-month" dateTime={month}>{month.slice(0, 4)}년 {Number(month.slice(5))}월</time>
          <HomeSource source="샘플 데이터" detail={storageWarning ? '브라우저 저장 상태 확인 필요' : '이 브라우저에 저장'} />
          <SettingsWindow demo />
        </div>
      </div>
      <EditorialHome
        budget={<BudgetSummary budget={BigInt(budget)} spent={BigInt(spent)} scheduled={BigInt(scheduled)} href="/demo/budgets" />}
        assets={<DemoAssetChart data={data} approved={approved} date={todayDate} />}
        review={<ReviewPanel href="/transactions?mode=demo&tab=review" count={pending.length} amount={BigInt(total(pending))}>
          {recoveryCount > 0 && <a className="home-review-status" href="/notification-recovery">알림 복구 필요 {recoveryCount}건</a>}
          {recentPending.length > 0 && <ul className="home-review-list">{recentPending.map((purchase) => <li key={purchase.id}>
            <div><strong>{purchase.merchant}</strong><small>{purchase.date} · {data.categories.find((item) => item.id === purchase.categoryId)?.name ?? '미분류'}</small></div>
            <b>{homeWon(purchase.amount)}</b>
          </li>)}</ul>}
        </ReviewPanel>}
        recurring={<RecurringPayments payments={remainingPayments} date={todayDate} />}
        categories={<CategorySpending entries={categorySpending} total={BigInt(spent)} />}
      />
    </section>}
    <div className="feedback" role="status">{storageWarning || notice}</div>
    {reviewPage && <section id="transactions" className="panel" aria-labelledby="transactions-title">
      <div className="section-heading demo-heading"><h2 id="transactions-title">거래 목록</h2><div className="row-actions">
        <a className="button outline" href="/transactions?tab=review&mode=connected">연결된 거래 검토</a>
        <a className="button outline" href="/notification-recovery">알림 복구</a>
        <a className="button outline" href="#purchase-form">거래 입력</a>
      </div></div>
      <div className="toolbar">
        <label>가맹점 검색<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSelected([]) }} placeholder="가맹점 이름" /></label>
        <label>카테고리<select value={category} onChange={(event) => { setCategory(event.target.value); setSelected([]) }}>
          <option value="">전체</option>{data.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <button type="button" disabled={!selected.length} onClick={() => approve(selected)}>선택 승인 ({selected.length})</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th scope="col">선택</th><th scope="col">가맹점</th><th scope="col">거래일</th><th scope="col">계좌</th><th scope="col">카테고리</th><th scope="col" className="numeric">금액</th><th scope="col">상태</th><th scope="col">작업</th></tr></thead>
          <tbody>
            {visible.map((purchase) => <tr key={purchase.id}>
              <td>{purchase.status === 'pending' && <input type="checkbox" aria-label={`${purchase.merchant} 선택`} checked={selected.includes(purchase.id)} onChange={(event) => {
                const checked = event.target.checked
                setSelected((current) => checked ? [...current, purchase.id] : current.filter((id) => id !== purchase.id))
              }} />}</td>
              <th scope="row">{purchase.merchant}</th><td>{purchase.date}</td>
              <td>{data.accounts.find((account) => account.id === purchase.accountId)?.name}</td>
              <td>{data.categories.find((category) => category.id === purchase.categoryId)?.name}</td>
              <td className="numeric">{won(purchase.amount)}</td>
              <td><span className={`badge ${purchase.status}`}>{purchase.status === 'pending' ? '대기' : '확정'}</span></td>
              <td>{purchase.status === 'pending' && <div className="row-actions"><a href="#purchase-form" onClick={() => setEditing(purchase)}>수정</a><button type="button" className="outline" onClick={() => approve([purchase.id])}>승인</button></div>}</td>
            </tr>)}
            {!visible.length && <tr><td colSpan={8}>조건에 맞는 거래가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      <form id="purchase-form" key={editing?.id ?? 'new'} onSubmit={savePurchase}>
        <h3>{editing ? '대기 거래 수정' : '새 구매 거래'}</h3>
        <div className="fields">
          <label>가맹점<input name="merchant" required maxLength={80} defaultValue={editing?.merchant} /></label>
          <label>거래일<input name="date" type="date" required defaultValue={editing?.date ?? today()} /></label>
          <label>금액 (원)<input name="amount" type="number" min="1" max="100000000000" required defaultValue={editing?.amount} /></label>
          <label>계좌<select name="accountId" required defaultValue={editing?.accountId}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>카테고리<select name="categoryId" required defaultValue={editing?.categoryId}>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        </div>
        <div className="row-actions"><button type="submit">{editing ? '수정 저장' : '대기에 추가'}</button>{editing && <button type="button" className="outline" onClick={() => setEditing(null)}>취소</button>}</div>
      </form>
    </section>}
    {page === 'accounts' && <section id="accounts" className="panel" aria-labelledby="accounts-title">
        <div className="section-heading demo-heading"><h1 id="accounts-title">계좌·카드 설정</h1></div>
        <ul className="summary-list">{balances.map((account) => <li key={account.id}><div><strong>{account.name}</strong><small>{account.kind === 'asset' ? '자산' : '카드 부채'} · 초기 {won(account.opening)}</small></div><strong>{won(account.balance)}</strong></li>)}</ul>
        <form onSubmit={saveAccount}>
          <h3>계좌 추가</h3>
          <div className="fields"><label>이름<input name="name" required maxLength={60} /></label><label>계좌 유형<select name="kind"><option value="asset">자산</option><option value="credit">신용카드 부채</option></select></label><label>초기 잔액 (원)<input type="number" name="opening" min="0" max="100000000000" required /></label></div>
          <button type="submit">계좌 추가</button>
        </form>
      </section>}
    {page === 'budgets' && <section id="budgets" className="panel" aria-labelledby="budgets-title">
        <div className="section-heading demo-heading"><h1 id="budgets-title">카테고리·예산 설정</h1></div>
        <ul className="summary-list">{data.categories.map((category) => {
          const used = categoryTotals.get(category.id) ?? 0
          return <li key={category.id} className="budget-item"><div><strong>{category.name}</strong><small>{won(used)} / {won(category.budget)}</small></div><progress aria-label={`${category.name} 예산 사용량`} value={Math.min(used, category.budget)} max={category.budget || 1} /><small>{used > category.budget ? `초과 ${won(used - category.budget)}` : `남은 예산 ${won(category.budget - used)}`}</small></li>
        })}</ul>
        <form onSubmit={saveCategory}>
          <h3>카테고리·월 예산 설정</h3>
          <p>기존 카테고리 이름을 입력하면 예산을 변경합니다.</p>
          <div className="fields"><label>카테고리 이름<input name="name" required maxLength={60} /></label><label>월 예산 (원)<input name="budget" type="number" min="0" max="100000000000" required /></label></div>
          <button type="submit">예산 저장</button>
        </form>
      </section>}
  </>
  if (embedded) return content

  return (
    <div className={`shell demo-dashboard${menuOpen ? '' : ' compact'}${page === 'overview' ? ' editorial-home' : ''}`}>
      <aside className="sidebar">
        <div className="home-brand-row">
          <a className="brand" href={page === 'overview' ? '#overview' : '/demo'} aria-label="자산 관리"><span aria-hidden="true">₩</span> <strong>자산 관리</strong></a>
          <button className="sidebar-toggle" type="button" aria-controls="demo-main-menu" aria-expanded={menuOpen} aria-label={menuOpen ? '메뉴 접기' : '메뉴 펼치기'} title={menuOpen ? '메뉴 접기' : '메뉴 펼치기'} onClick={() => setMenuOpen(!menuOpen)}>
            <span aria-hidden="true">{menuOpen ? '‹' : '›'}</span>
          </button>
        </div>
        <nav id="demo-main-menu" aria-label="메인 메뉴">
          {sections.map((section) => section.href ? <a key={section.id} href={page !== 'overview' && section.href.startsWith('#') ? '/demo' : section.href}
            aria-label={section.label} title={section.label + (section.id === 'reports' ? ' · 연결된 원장' : '')}
            aria-current={page === section.id ? 'page' : undefined}>
            <span aria-hidden="true">{section.mark}</span><span className="nav-label">{section.label}</span>
          </a> : <span className="demo-nav-disabled" key={section.id} aria-disabled="true"
            aria-label={section.label + ' · 화면 준비 중'} title="투자·외화 화면 준비 중">
            <span aria-hidden="true">{section.mark}</span><span className="nav-label">{section.label}</span>
          </span>)}
        </nav>
      </aside>
      <main>
        {page !== 'overview' && <header className="topbar"><HomeSource source="샘플 데이터" detail="이 브라우저에 저장" /></header>}
        <div className="content">{content}</div>
      </main>
    </div>
  )
}
