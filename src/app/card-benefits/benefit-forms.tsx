'use client'

import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { formatWon } from '@/lib/format-finance'

type Option = { id: string; name: string }
type Estimate = {
  estimated_minor: string
  remaining_cap_minor: string | null
  eligibility: 'eligible' | 'prior_spend' | 'category' | 'cap'
  terms_version: number
  source: string
  rate_bps: number
}

const eligibility: Record<Estimate['eligibility'], string> = {
  eligible: '입력한 실적과 혜택 조건을 충족합니다.',
  prior_spend: '전월 인정 실적이 기준에 미달했습니다.',
  category: '구매 카테고리가 약관의 대상과 다릅니다.',
  cap: '이번 달 혜택 한도를 모두 사용했습니다.',
}
const errors: Record<string, string> = {
  BENEFIT_TERMS_NOT_FOUND: '예정일에 적용되는 약관이 없습니다.',
  BENEFIT_CARD_NOT_FOUND: '사용할 수 있는 카드 계좌를 확인해 주세요.',
  BENEFIT_CATEGORY_NOT_FOUND: '카테고리를 다시 선택해 주세요.',
  CARD_BENEFIT_REQUEST_CONFLICT: '이 요청은 다른 약관으로 저장됐습니다. 화면을 새로고침해 확인해 주세요.',
  INVALID_INPUT: '날짜와 금액, 혜택률을 확인해 주세요.',
  UNAUTHORIZED: '인증된 사용자 세션이 필요합니다.',
}
const amountPattern = '0|[1-9][0-9]{0,18}'

export default function BenefitForms({ cards, categories, today }: { cards: Option[]; categories: Option[]; today: string }) {
  const router = useRouter()
  const [pending, setPending] = useState<'register' | 'estimate' | null>(null)
  const [registered, setRegistered] = useState('')
  const [estimateNotice, setEstimateNotice] = useState('')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>, action: 'register' | 'estimate') {
    event.preventDefault()
    if (pending) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const registering = action === 'register'
    const payload = {
      action, card_id: fields.get('card'), category_id: fields.get('category') || null,
      ...(registering ? {
        effective_from: fields.get('effectiveFrom'), effective_until: fields.get('effectiveUntil') || null,
        source: fields.get('source'), rate_bps: Math.round(Number(fields.get('rate')) * 100),
        prior_spend_minor: fields.get('threshold'), monthly_cap_minor: fields.get('cap') || null,
      } : {
        purchase_date: fields.get('purchaseDate'), eligible_amount_minor: fields.get('amount'),
        prior_eligible_minor: fields.get('prior'), used_benefit_minor: fields.get('used'),
      }),
    }
    const setNotice = registering ? setRegistered : setEstimateNotice
    setPending(action)
    setNotice('')
    setEstimate(null)
    try {
      if (registering) {
        const fingerprint = JSON.stringify(payload)
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
      }
      const response = await fetch('/api/card-benefits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(registering && { request_id: request.current?.id }) }),
      })
      const result = await response.json()
      if (!response.ok) {
        setNotice(errors[result.error] ?? '카드 혜택 요청을 처리하지 못했습니다.')
        return
      }
      if (registering) {
        request.current = null
        setRegistered('약관 버전 ' + result.version + '을 저장했습니다.')
        router.refresh()
      } else {
        setEstimate(result)
      }
    } catch {
      setNotice('결과를 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.')
    } finally {
      setPending(null)
    }
  }

  if (!cards.length) return <section className="panel">
    <p>카드 혜택을 등록하려면 카드 부채 계좌가 필요합니다.</p>
    <a href="/finance-settings">계좌 설정 열기</a>
  </section>

  const cardOptions = cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)
  const categoryOptions = categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)

  return <div className="detail-grid">
    <section className="panel" aria-labelledby="benefit-estimate">
      <h2 id="benefit-estimate">예상 혜택 계산</h2>
      <p>카드사 명세서의 전월 인정 실적과 이번 달 사용 혜택을 입력하세요. 혜택에서 제외되는 구매 금액은 빼고 입력하세요.</p>
      <form onSubmit={(event) => void submit(event, 'estimate')} onChange={() => setEstimate(null)}>
        <fieldset disabled={Boolean(pending)}>
          <legend>구매와 카드 실적</legend>
          <div className="fields">
            <label>사용할 카드<select name="card" required>{cardOptions}</select></label>
            <label>구매 예정일<input type="date" name="purchaseDate" defaultValue={today} min="1900-01-01" max="9998-12-31" required /></label>
            <label>구매 카테고리<select name="category"><option value="">미지정</option>{categoryOptions}</select></label>
            <label>혜택 대상 구매액 (원)<input name="amount" inputMode="numeric" pattern={amountPattern} required /></label>
            <label>전월 인정 실적 (원)<input name="prior" inputMode="numeric" pattern={amountPattern} required /></label>
            <label>당월 사용한 혜택 (원)<input name="used" inputMode="numeric" pattern={amountPattern} required /></label>
          </div>
          <button type="submit">예상 혜택 계산</button>
        </fieldset>
      </form>
      <p role="status">{estimateNotice}</p>
      {estimate && <div className="recovery-message" role="status">
        <p>예상 혜택 <strong>{formatWon(estimate.estimated_minor)}</strong> · {eligibility[estimate.eligibility]}</p>
        <p>계산 전 남은 월 한도 {estimate.remaining_cap_minor === null ? '제한 없음' : formatWon(estimate.remaining_cap_minor)}</p>
        <small>적용 약관 버전 {estimate.terms_version} · 혜택률 {estimate.rate_bps / 100}% · {estimate.source}</small>
      </div>}
    </section>
    <section className="panel" aria-labelledby="benefit-terms">
      <h2 id="benefit-terms">카드 약관 등록</h2>
      <p>정률 혜택을 원 단위로 내림해 계산합니다. 약관의 적용 범위와 한도를 확인한 뒤 저장하세요.</p>
      <form onSubmit={(event) => void submit(event, 'register')}>
        <fieldset disabled={Boolean(pending)}>
          <legend>약관 버전</legend>
          <div className="fields">
            <label>약관 대상 카드<select name="card" required>{cardOptions}</select></label>
            <label>약관 출처<input name="source" maxLength={200} required /></label>
            <label>적용 시작일<input name="effectiveFrom" type="date" defaultValue={today} min="1900-01-01" max="9998-12-31" required /></label>
            <label>적용 종료일<input name="effectiveUntil" type="date" min="1900-01-01" max="9998-12-31" /></label>
            <label>혜택 카테고리<select name="category"><option value="">카테고리 제한 없음</option>{categoryOptions}</select></label>
            <label>혜택률 (%)<input name="rate" type="number" min="0.01" max="100" step="0.01" required /></label>
            <label>전월 최소 실적 (원)<input name="threshold" inputMode="numeric" pattern={amountPattern} defaultValue="0" required /></label>
            <label>월 혜택 한도 (원)<input name="cap" inputMode="numeric" pattern={amountPattern} placeholder="한도 제한 없으면 비워 두기" /></label>
          </div>
          <button type="submit">약관 버전 저장</button>
        </fieldset>
      </form>
      <p role="status">{registered}</p>
    </section>
  </div>
}
