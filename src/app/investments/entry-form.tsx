'use client'
import { useState } from 'react'
import { dec, decimal, mul, div, kinds, money, type Entry, type Book, type Kind } from '@/lib/investment-book'
import { emptyEntry } from '@/lib/investment-demo'
export const localDate = (date: string) => {
  const value = new Date(date)
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}
export function EntryForm({
  book,
  initial,
  fx,
  onSave,
  onClose,
}: {
  book: Book
  initial?: Partial<Entry>
  fx: boolean
  onSave: (e: Entry) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Entry>(() => ({
    ...emptyEntry,
    id: crypto.randomUUID(),
    account: book.accounts[0]?.id || '',
    at: new Date().toISOString(),
    kind: fx ? 'deposit' : 'buy',
    ...initial,
  }))
  const originalPrice =
    initial?.qty && initial.gross ? decimal(div(dec(initial.gross), dec(initial.qty))) : ''
  const [price, setPrice] = useState(originalPrice)
  const [date, setDate] = useState(localDate(draft.at)),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const trade = draft.kind === 'buy' || draft.kind === 'sell',
    security = trade || draft.kind === 'dividend'
  const cash = ['deposit', 'withdraw', 'transfer'].includes(draft.kind)
  const update = (key: keyof Entry, value: string) =>
    setDraft((p) => ({
      ...p,
      [key]: value,
      ...(key === 'currency' && p.currency !== value ? { rate: value === 'KRW' ? '1' : '' } : {}),
    }))
  let gross = draft.gross
  if (trade) {
    try {
      gross =
        initial?.gross && draft.qty === initial.qty && price === originalPrice
          ? initial.gross
          : decimal(mul(dec(price), dec(draft.qty)))
    } catch {
      gross = '0'
    }
  }
  function input(label: string, key: keyof Entry, numeric = false, required = true) {
    return (
      <label>
        {label}
        <input
          required={required}
          value={String(draft[key] ?? '')}
          maxLength={numeric ? 28 : 120}
          inputMode={numeric ? 'decimal' : 'text'}
          onChange={(e) =>
            update(
              key,
              ['currency', 'target', 'symbol'].includes(key) ? e.target.value.toUpperCase() : e.target.value,
            )
          }
        />
      </label>
    )
  }
  const fee = cash ? '0' : draft.fee,
    tax = cash ? '0' : draft.tax
  let total = '—',
    fxRatio = ''
  try {
    total = decimal(dec(gross) + (['buy', 'fx'].includes(draft.kind) ? 1n : -1n) * (dec(fee) + dec(tax)))
    if (draft.kind === 'fx' && dec(draft.received) > 0n)
      fxRatio = decimal(div(dec(gross), dec(draft.received)))
  } catch {
    /* Incomplete fields while typing. */
  }
  return (
    <form
      className="iv-form"
      onSubmit={async (ev) => {
        ev.preventDefault()
        setError('')
        setBusy(true)
        try {
          const at = new Date(date).toISOString(),
            rate = draft.currency === 'KRW' ? '1' : draft.rate
          if (Date.parse(at) > Date.now()) throw Error('미래 거래는 입력할 수 없습니다.')
          const currencies = Intl.supportedValuesOf('currency')
          if (
            !currencies.includes(draft.currency) ||
            (draft.kind === 'fx' && !currencies.includes(draft.target))
          )
            throw Error('지원되는 ISO 통화 코드를 입력하세요.')
          if (security && !/^[A-Z0-9][A-Z0-9.:-]{0,39}$/.test(draft.symbol))
            throw Error('티커와 거래소 코드를 확인하세요.')
          if (
            dec(gross) <= 0n ||
            (trade && (dec(price) <= 0n || dec(draft.qty) <= 0n)) ||
            dec(fee) < 0n ||
            dec(tax) < 0n ||
            ((rate || !cash) && dec(rate) <= 0n)
          )
            throw Error('수량, 단가, 환율과 비용을 확인하세요.')
          if (['sell', 'dividend'].includes(draft.kind) && dec(fee) + dec(tax) > dec(gross))
            throw Error('비용이 거래 금액을 초과합니다.')
          await onSave({
            ...draft,
            at,
            gross,
            fee,
            tax,
            rate,
            symbol: security ? draft.symbol : '',
            qty: trade ? draft.qty : '',
            target: draft.kind === 'fx' ? draft.target : '',
            received: draft.kind === 'fx' ? draft.received : '',
            destination: draft.kind === 'transfer' ? draft.destination : '',
            legacy: false,
          })
          onClose()
        } catch (err) {
          setError(err instanceof Error ? err.message : '저장 실패')
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        거래 유형
        <select value={draft.kind} onChange={(e) => update('kind', e.target.value)}>
          {(Object.keys(kinds) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {kinds[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        거래 계좌
        <select required value={draft.account} onChange={(e) => update('account', e.target.value)}>
          {book.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        거래 일시
        <input
          required
          type="datetime-local"
          step="1"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {input(draft.kind === 'fx' ? '매도 통화' : '거래 통화', 'currency')}
      {security && (
        <>
          {input('티커', 'symbol')}
          {input('종목명', 'name', false, false)}
          {input('거래소', 'exchange', false, false)}
          <label>
            종목 구분
            <select value={draft.category} onChange={(e) => update('category', e.target.value)}>
              <option value="unknown">미분류</option>
              <option value="domestic">국내</option>
              <option value="overseas">해외</option>
              <option value="etf">ETF</option>
            </select>
          </label>
        </>
      )}
      {trade ? (
        <>
          {input('보유 변동 수량', 'qty', true)}
          <label>
            체결 단가
            <input required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        </>
      ) : (
        input(draft.kind === 'fx' ? '매도 수량' : '금액', 'gross', true)
      )}
      {draft.currency !== 'KRW' &&
        (!cash || draft.kind === 'deposit') &&
        input(cash ? '취득 환율 (선택 · 원/1단위)' : '거래 환율 (원/1단위)', 'rate', true, !cash)}
      {draft.kind === 'fx' && (
        <>
          {input('매수 통화', 'target')}
          {input('매수 수량', 'received', true)}
          {fxRatio && (
            <small>
              적용 환율 · 1 {draft.target} = {fxRatio} {draft.currency}
            </small>
          )}
        </>
      )}
      {draft.kind === 'transfer' && (
        <label>
          받는 계좌
          <select required value={draft.destination} onChange={(e) => update('destination', e.target.value)}>
            <option value="">계좌 선택</option>
            {book.accounts
              .filter((a) => a.id !== draft.account)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {!cash && (
        <>
          {input('수수료', 'fee', true)}
          {input('세금', 'tax', true)}
        </>
      )}
      {input('메모', 'memo', false, false)}
      <div className="iv-total">
        거래 합계{' '}
        <strong>
          {total === '—' || !/^[A-Z]{3}$/.test(draft.currency) ? '—' : money(dec(total), draft.currency)}
        </strong>
      </div>
      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}
      <div className="iv-actions">
        <button type="button" className="outline" onClick={onClose}>
          닫기
        </button>
        <button disabled={busy}>거래 저장</button>
      </div>
    </form>
  )
}
