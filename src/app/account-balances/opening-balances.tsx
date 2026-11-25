'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { formatSeoulTime, formatWon } from '@/lib/format-finance'

type AccountBalance = {
  id: string
  name: string
  kind: 'asset' | 'liability'
  opening_amount_minor: string | null
  opening_effective_at: string | null
  ledger_change_minor: string | null
  balance_minor: string | null
}

function message(status: number) {
  if (status === 401) return '조회하거나 저장하려면 인증된 사용자 세션이 필요합니다.'
  if (status === 503) return 'Supabase 연결이 설정되지 않았습니다.'
  if (status === 409) return '이 계좌의 초기 잔액이 이미 기록되어 있습니다.'
  if (status === 404 || status === 422) return '저장할 수 없는 계좌입니다.'
  if (status === 400) return '금액과 기준 시각을 확인해 주세요. 미래 시각은 사용할 수 없습니다.'
  return '요청 결과를 확인하지 못했습니다. 다시 시도해 주세요.'
}

export default function OpeningBalances() {
  const [accounts, setAccounts] = useState<AccountBalance[]>([])
  const [selected, setSelected] = useState<AccountBalance | null>(null)
  const [currentTime, setCurrentTime] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/account-balances', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(message(response.status))
        setAccounts((await response.json()).accounts)
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setListError(error.message)
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision])

  function refresh() {
    setSelected(null)
    setLoading(true)
    setListError('')
    setRevision((value) => value + 1)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || saving) return
    const values = new FormData(event.currentTarget)
    const local = String(values.get('effectiveAt') ?? '')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
      setNotice('기준 시각을 확인해 주세요.')
      return
    }
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/account-balances', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: selected.id, amount_minor: values.get('amount'), effective_at: local + ':00+09:00' }),
      })
      if (!response.ok) {
        setNotice(message(response.status))
        if (response.status === 409) refresh()
        return
      }
      setNotice(selected.name + '의 초기 잔액을 기록했습니다.')
      refresh()
    } catch {
      setNotice('저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="connected-review">
      <section className="panel" aria-labelledby="account-list" aria-busy={loading}>
        <div className="section-heading">
          <h2 id="account-list">계산 잔액</h2>
          <button type="button" className="outline" onClick={refresh} disabled={loading || saving}>새로고침</button>
        </div>
        {loading && <p role="status">계좌 잔액을 불러오는 중입니다.</p>}
        {listError && <p role="alert">{listError}</p>}
        {!loading && !listError && !accounts.length && <p>등록된 원화 자산·부채 계좌가 없습니다.</p>}
        {!listError && accounts.length > 0 && <div className="table-scroll"><table>
          <thead><tr><th scope="col">계좌</th><th scope="col">초기 잔액 · 기준 시각</th>
            <th scope="col" className="numeric">원장 증감</th><th scope="col" className="numeric">계산 잔액</th><th scope="col">작업</th></tr></thead>
          <tbody>{accounts.map((account) => (
            <tr key={account.id}>
              <th scope="row">{account.name}<br /><small>{account.kind === 'asset' ? '자산' : '부채'}</small></th>
              <td>{account.opening_amount_minor !== null && account.opening_effective_at
                ? <>{formatWon(account.opening_amount_minor)}<br /><small>{formatSeoulTime(account.opening_effective_at)}</small></>
                : '미등록'}</td>
              <td className="numeric">{account.ledger_change_minor === null ? '·' : formatWon(account.ledger_change_minor)}</td>
              <td className="numeric">{account.balance_minor === null ? '·' : formatWon(account.balance_minor)}</td>
              <td>{account.opening_amount_minor === null && <button type="button" className="outline"
                aria-label={account.name + ' 초기 잔액 등록'} disabled={loading || saving} onClick={() => {
                  setCurrentTime(new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16))
                  setSelected(account)
                  setNotice('')
                }}>초기 잔액 등록</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>}
        <p className="recovery-message">기준 시각부터 현재까지의 확정 원장 분개를 반영합니다.</p>
      </section>
      <section className="panel" aria-labelledby="opening-title">
        <h2 id="opening-title">초기 잔액 등록</h2>
        {selected ? <form key={selected.id} onSubmit={save}>
          <p><strong>{selected.name}</strong></p>
          <p>기준 시각 전의 구매는 입력한 초기 잔액에 반영된 것으로 계산합니다. 저장 후에는 원장 기록을 직접 수정할 수 없습니다.</p>
          <div className="fields">
            <label>초기 잔액 (원)<input name="amount" inputMode="numeric" pattern="0|[1-9][0-9]{0,18}" required disabled={saving} /></label>
            <label>기준 시각 (한국 시간)<input type="datetime-local" name="effectiveAt" defaultValue={currentTime} required disabled={saving} /></label>
          </div>
          <div className="row-actions">
            <button type="submit" disabled={saving}>{saving ? '기록 중' : '초기 잔액 확정'}</button>
            <button type="button" className="outline" disabled={saving} onClick={() => setSelected(null)}>취소</button>
          </div>
        </form> : <p className="recovery-message">초기 잔액을 기록할 계좌를 선택하세요.</p>}
        <p role="status" className="recovery-message">{notice}</p>
      </section>
    </div>
  )
}
