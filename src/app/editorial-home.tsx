import type { ReactNode } from 'react'
import { daysBetween } from '@/lib/home-dates'
import { formatMinor } from '@/lib/transaction-history'

const number = new Intl.NumberFormat('ko-KR')
export const homeWon = (value: bigint | number | string) => number.format(typeof value === 'string' ? BigInt(value) : value) + '원'

export function EditorialHome({ budget, assets, review, recurring, categories }: {
  budget: ReactNode; assets: ReactNode; review: ReactNode; recurring: ReactNode; categories: ReactNode
}) {
  return <div className="editorial-grid">
    <div className="editorial-column">{budget}{assets}</div>
    <div className="editorial-column">{review}{recurring}{categories}</div>
  </div>
}

export function ReviewPanel({ href, count, amount, children }: {
  href: string; count: number | null; amount: bigint | null; children?: ReactNode
}) {
  return <section className="home-review" aria-labelledby="home-review-heading">
    <h2 id="home-review-heading">거래 검토</h2>
    {count === null ? <p className="home-empty">대기 거래를 불러오지 못했습니다.</p> : <>
      <p className="home-review-total"><strong>{count}건</strong><span>검토 대상</span></p>
      <p className="home-review-amount">원화 합계 <strong>{amount === null ? '조회 불가' : homeWon(amount)}</strong></p>
    </>}
    {children}
    <a className="button home-review-action" href={href}>{count === 0 ? '거래 보기' : '거래 검토하기'} <span aria-hidden="true">→</span></a>
  </section>
}

type Payment = { id: string; name: string; amount: number | string; due: string; currency?: string; href?: string }

function PaymentList({ payments, date }: { payments: Payment[]; date: string }) {
  return <ul className="home-payment-list">{payments.map((item) => {
    const days = daysBetween(date, item.due)
    const due = days === 0 ? 'D-Day' : days > 0 ? 'D-' + days : 'D+' + -days + ' · 지연'
    return <li key={item.id}>
      <div>{item.href ? <a className="home-payment-link" href={item.href}>{item.name}</a> : <strong>{item.name}</strong>}
        <div className="home-payment-date"><time dateTime={item.due}>{Number(item.due.slice(5, 7))}월 {Number(item.due.slice(8))}일</time>
          <span data-overdue={days < 0}>{due}</span></div>
      </div>
      <b>{item.currency && item.currency !== 'KRW' ? formatMinor(String(item.amount), item.currency) : homeWon(item.amount)}</b>
    </li>
  })}</ul>
}

export function RecurringPayments({ payments, date, href, unread }: { payments: Payment[] | null; date: string; href?: string; unread?: number }) {
  return <section className="home-recurring" aria-labelledby="home-recurring-heading">
    <div className="home-section-heading">
      <h2 id="home-recurring-heading">다가오는 정기 결제</h2>
      {href && <a className="home-text-link" href={href}>전체 보기{unread ? ' · 알림 ' + unread : ''} <span aria-hidden="true">→</span></a>}
    </div>
    {payments === null ? <p className="home-empty">연결된 정기 결제 일정이 없습니다.</p> : payments.length ? <>
      <div className="home-payment-preview"><PaymentList payments={payments.slice(0, 3)} date={date} /></div>
      {!href && payments.length > 3 && <details className="home-details home-more-payments">
        <summary><span className="home-payments-more">전체 보기 ({payments.length}건)</span><span className="home-payments-less">간략히 보기</span></summary>
        <PaymentList payments={payments.slice(3)} date={date} />
      </details>}
    </> : <p className="home-empty">이번 달에 남은 정기 결제가 없습니다.</p>}
  </section>
}
