'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { PurchaseOptions } from '@/lib/supabase/purchase-options'

export default function FinanceSettings() {
  const [data, setData] = useState<PurchaseOptions | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/finance-settings', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) throw new Error('계좌와 카테고리를 설정하려면 인증된 사용자 세션이 필요합니다.')
        if (response.status === 503) throw new Error('Supabase 연결이 설정되지 않았습니다.')
        if (!response.ok) throw new Error('설정을 불러오지 못했습니다.')
        setData(await response.json())
      }).catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message)
      })
    return () => controller.abort()
  }, [revision])

  async function save(event: FormEvent<HTMLFormElement>, type: 'account' | 'category') {
    event.preventDefault()
    if (saving) return
    const form = event.currentTarget
    const fields = new FormData(form)
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/finance-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name: fields.get('name'), kind: fields.get('kind') }),
      })
      if (response.status === 400) setNotice('입력한 이름과 계좌 유형을 확인해 주세요.')
      else if (!response.ok) setNotice('저장하지 못했습니다. 같은 이름으로 다시 시도할 수 있습니다.')
      else {
        setNotice(type === 'account' ? '계좌 설정을 저장했습니다.' : '카테고리 설정을 저장했습니다.')
        form.reset()
        setError('')
        setRevision((value) => value + 1)
      }
    } catch {
      setNotice('저장 결과를 확인하지 못했습니다. 같은 이름으로 다시 시도할 수 있습니다.')
    } finally {
      setSaving(false)
    }
  }

  if (!data || error) return <section className="panel"><p role={error ? 'alert' : 'status'}>{error || '설정을 불러오는 중입니다.'}</p></section>
  return <>
    <div className="detail-grid">
      <section className="panel" aria-labelledby="settings-accounts">
        <h2 id="settings-accounts">결제 계좌</h2>
        {data.accounts.length ? <ul className="summary-list">
          {data.accounts.map((account) => <li key={account.id}><strong>{account.name}</strong>
            <span>{account.kind === 'asset' ? '자산' : '카드 부채'}</span></li>)}
        </ul> : <p className="recovery-message">등록된 결제 계좌가 없습니다.</p>}
        <form onSubmit={(event) => save(event, 'account')}>
          <div className="fields">
            <label>계좌 이름<input name="name" maxLength={100} required disabled={saving} /></label>
            <label>계좌 유형<select name="kind" disabled={saving}><option value="asset">원화 자산</option>
              <option value="liability">원화 카드 부채</option></select></label>
          </div>
          <button type="submit" disabled={saving}>계좌 추가</button>
        </form>
      </section>
      <section className="panel" aria-labelledby="settings-categories">
        <h2 id="settings-categories">비용 카테고리</h2>
        {data.categories.length ? <ul className="summary-list">
          {data.categories.map((category) => <li key={category.id}><strong>{category.name}</strong></li>)}
        </ul> : <p className="recovery-message">등록된 비용 카테고리가 없습니다.</p>}
        <form onSubmit={(event) => save(event, 'category')}>
          <label>카테고리 이름<input name="name" maxLength={80} required disabled={saving} /></label>
          <button type="submit" disabled={saving}>카테고리 추가</button>
        </form>
      </section>
    </div>
    <p role="status" className="recovery-message">{notice}</p>
  </>
}
