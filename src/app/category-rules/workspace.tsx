'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Rule = { id: string; merchant: string; category_id: string }
type Rules = { rules: Rule[]; categories: { id: string; name: string }[] }

export default function CategoryRules() {
  const [data, setData] = useState<Rules | null>(null)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/category-rules', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) throw new Error('분류 규칙을 설정하려면 인증된 사용자 세션이 필요합니다.')
        if (response.status === 503) throw new Error('Supabase 연결이 설정되지 않았습니다.')
        if (!response.ok) throw new Error('분류 규칙을 불러오지 못했습니다.')
        setData(await response.json())
      }).catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message)
      })
    return () => controller.abort()
  }, [revision])

  async function save(merchant: FormDataEntryValue | null, category: FormDataEntryValue | null) {
    if (saving || typeof merchant !== 'string') return
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/category-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', merchant, category_id: category }),
      })
      if (!response.ok) {
        setNotice(response.status === 404 ? '사용할 수 없는 카테고리입니다.' : '규칙을 저장하지 못했습니다.')
        return
      }
      setEditing(null)
      setNotice(category === null ? '규칙을 해제했습니다.' : '규칙을 저장했습니다.')
      setError('')
      setRevision((value) => value + 1)
    } catch {
      setNotice('저장 결과를 확인하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    void save(editing?.merchant ?? values.get('merchant'), values.get('category'))
  }

  if (!data || error) return <section className="panel"><p role={error ? 'alert' : 'status'}>{error || '규칙을 불러오는 중입니다.'}</p></section>
  return <div className="detail-grid">
    <section className="panel" aria-labelledby="saved-rules">
      <h2 id="saved-rules">저장된 규칙</h2>
      {data.rules.length ? <ul className="summary-list">{data.rules.map((rule) => <li key={rule.id}>
        <div><strong>{rule.merchant}</strong><small>{data.categories.find((item) => item.id === rule.category_id)?.name ?? '카테고리 확인 필요'}</small></div>
        <div className="row-actions">
          <button type="button" className="outline" disabled={saving} onClick={() => { setEditing(rule); setNotice('') }}>변경</button>
          <button type="button" className="outline" disabled={saving} onClick={() => save(rule.merchant, null)}>해제</button>
        </div>
      </li>)}</ul> : <p className="recovery-message">저장된 규칙이 없습니다.</p>}
    </section>
    <section className="panel" aria-labelledby="rule-input">
      <h2 id="rule-input">{editing ? '규칙 변경' : '규칙 추가'}</h2>
      <p className="recovery-message">새 구매를 입력할 때 같은 가맹점의 카테고리를 제안합니다.</p>
      <form key={(editing?.id ?? 'new') + ':' + revision} onSubmit={submit}>
        <div className="fields">
          <label>가맹점 이름<input name="merchant" defaultValue={editing?.merchant ?? ''} readOnly={Boolean(editing)}
            required maxLength={200} disabled={saving} /></label>
          <label>카테고리<select name="category" defaultValue={editing?.category_id ?? ''} required disabled={saving}>
            <option value="">카테고리 선택</option>
            {data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select></label>
        </div>
        <div className="row-actions"><button type="submit" disabled={saving || !data.categories.length}>규칙 저장</button>
          {editing && <button type="button" className="outline" disabled={saving} onClick={() => setEditing(null)}>취소</button>}
        </div>
      </form>
      <p role="status" className="recovery-message">{notice}</p>
    </section>
  </div>
}
