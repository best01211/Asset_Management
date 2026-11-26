'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { categoryTypeLabels } from '@/lib/category-catalog'
import type { Catalog, CatalogCategory, CatalogTag, CategoryType, CategoryUsage } from '@/lib/category-catalog'

type Edit = { id: string | null; parent_id: string; name: string; sort_order: number | ''; is_active: boolean; is_system: boolean }
const blank = (parent: string, nextOrder: number): Edit => ({ id: null, parent_id: parent, name: '', sort_order: nextOrder, is_active: true, is_system: false })
const errors: Record<string, string> = {
  CATEGORY_NAME_EXISTS: '같은 대분류에 이미 있는 이름입니다.',
  CATEGORY_PROTECTED: '기본 카테고리의 위치와 사용 상태는 보호됩니다.',
  CATEGORY_NOT_FOUND: '카테고리를 다시 불러와 주세요.',
  TAG_NOT_FOUND: '태그를 다시 불러와 주세요.',
  INVALID_INPUT: '이름과 순서를 확인해 주세요.',
}

export default function CatalogWorkspace() {
  const [data, setData] = useState<Catalog | null>(null)
  const [tab, setTab] = useState<CategoryType | 'tags'>('expense')
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [groupEdit, setGroupEdit] = useState<{ id: string; name: string } | null>(null)
  const [tag, setTag] = useState<{ id: string | null; name: string } | null>(null)
  const [usage, setUsage] = useState<CategoryUsage | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/categories', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (response.status === 401) throw new Error('카테고리를 관리하려면 인증된 사용자 세션이 필요합니다.')
      if (response.status === 503) throw new Error('Supabase 연결과 카테고리 마이그레이션을 확인해 주세요.')
      if (!response.ok) throw new Error('카테고리를 불러오지 못했습니다.')
      const catalog: Catalog = await response.json()
      if (!controller.signal.aborted) setData(catalog)
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [revision])

  async function submit(body: object, message: string) {
    if (saving) return
    setSaving(true)
    setNotice('')
    try {
      const response = await fetch('/api/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) {
        const result = await response.json()
        setNotice(errors[result.error] ?? (response.status === 409 ? '이미 사용 중인 이름입니다.' : '저장하지 못했습니다.'))
        return
      }
      setEdit(null)
      setGroupEdit(null)
      setTag(null)
      setUsage(null)
      setNotice(message)
      setError('')
      setRevision((value) => value + 1)
    } catch { setNotice('저장 결과를 확인하지 못했습니다.') }
    finally { setSaving(false) }
  }

  function editCategory(category: CatalogCategory) {
    setGroupEdit(null)
    setEdit(category)
    setUsage(null)
    setNotice('')
  }

  async function prepareDisable() {
    if (!edit?.id) return
    setLoadingUsage(true)
    setNotice('')
    try {
      const response = await fetch('/api/categories?' + new URLSearchParams({ usage: edit.id }), { cache: 'no-store' })
      if (!response.ok) throw new Error()
      setUsage(await response.json())
    } catch { setNotice('연결된 거래를 확인하지 못했습니다.') }
    finally { setLoadingUsage(false) }
  }

  const needle = search.trim().toLocaleLowerCase('ko')
  const matches = (name: string) => !needle || name.toLocaleLowerCase('ko').includes(needle)
  if (!data || error) return <section className="panel">
    <p role={error ? 'alert' : 'status'}>{error || '카테고리를 불러오는 중입니다.'}</p>
    {error && <button type="button" className="outline" onClick={() => { setError(''); setRevision((value) => value + 1) }}>다시 시도</button>}
  </section>

  return <>
    <div className="category-catalog-toolbar">
      <div className="review-filters" role="group" aria-label="관리 항목">
        {(['expense', 'income', 'tags'] as const).map((value) =>
          <button type="button" key={value} className={tab === value ? '' : 'outline'} aria-pressed={tab === value}
            disabled={saving || loadingUsage} onClick={() => {
              setTab(value); setSearch(''); setEdit(null); setGroupEdit(null); setTag(null); setUsage(null); setNotice('')
            }}>{value === 'tags' ? '태그' : categoryTypeLabels[value]}</button>)}
      </div>
      <label>검색<input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
        placeholder={tab === 'tags' ? '태그 이름' : '대분류·소분류 이름'} /></label>
    </div>
    <p className="category-catalog-notice" role="status">{notice}</p>
    <div className="category-catalog-grid">
      <section className="panel" aria-labelledby="catalog-list-title">
        <div className="section-heading"><h2 id="catalog-list-title">{tab === 'tags' ? '태그' : categoryTypeLabels[tab] + ' 카테고리'}</h2>
          {tab === 'tags' && <button type="button" disabled={saving} onClick={() => setTag({ id: null, name: '' })}>태그 추가</button>}</div>
        {tab === 'tags' ? <ul className="summary-list">{data.tags.filter((item) => matches(item.name)).map((item: CatalogTag) =>
          <li key={item.id}><strong>{item.name}</strong><button type="button" className="outline" disabled={saving}
            aria-label={item.name + ' 태그 수정'} onClick={() => { setTag(item); setNotice('') }}>수정</button></li>)}</ul> :
          data.groups.filter((item) => item.transaction_type === tab).map((group) => {
            const children = data.categories.filter((item) => item.parent_id === group.id)
            const visible = matches(group.name) ? children : children.filter((item) => matches(item.name))
            if (needle && !visible.length) return null
            return <details className="category-group" key={group.id} open={needle ? true : undefined}>
              <summary><span>{group.name}</span><small>{visible.length}개</small></summary>
              <ul className="summary-list">{visible.map((item) => <li key={item.id}>
                <div><strong>{item.name}</strong><small>{item.is_system ? '기본' : '사용자'}{!item.is_active && ' · 사용 중지'}</small></div>
                <button type="button" className="outline" disabled={saving || loadingUsage} aria-label={group.name + ' ' + item.name + ' 수정'}
                  onClick={() => editCategory(item)}>수정</button>
              </li>)}</ul>
              <div className="row-actions category-add-sub">
                <button type="button" className="outline" disabled={saving || loadingUsage} onClick={() => {
                  setGroupEdit(null); setUsage(null); setNotice(''); setEdit(blank(group.id, Math.min(1000000, Math.max(0, ...children.map((item) => item.sort_order)) + 10)))
                }}>소분류 추가</button>
                <button type="button" className="outline" disabled={saving || loadingUsage}
                  aria-label={group.name + ' 대분류 이름 수정'} onClick={() => { setEdit(null); setUsage(null); setNotice(''); setGroupEdit(group) }}>대분류 이름 수정</button>
              </div>
            </details>
          })}
        {needle && !(tab === 'tags' ? data.tags.some((item) => matches(item.name)) : data.groups.some((group) => group.transaction_type === tab
          && (matches(group.name) || data.categories.some((item) => item.parent_id === group.id && matches(item.name)))))
          && <p className="recovery-message">검색 결과가 없습니다.</p>}
      </section>
      {edit && <section className="panel" aria-labelledby="category-edit-title">
        <h2 id="category-edit-title">{edit.id ? '소분류 수정' : '소분류 추가'}</h2>
        <p className="recovery-message">{data.groups.find((group) => group.id === edit.parent_id)?.name}</p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void submit({ action: 'category', ...edit }, '카테고리를 저장했습니다.') }}>
          <label>소분류 이름<input value={edit.name} required maxLength={80} disabled={saving || loadingUsage}
            onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></label>
          <label>표시 순서<input type="number" min={0} max={1000000} step="1" required value={edit.sort_order} disabled={saving || loadingUsage}
            onChange={(event) => setEdit({ ...edit, sort_order: event.target.value ? event.target.valueAsNumber : '' })} /></label>
          <p>숫자가 작은 소분류부터 표시됩니다.</p>
          <div className="row-actions">
            <button type="submit" disabled={saving || loadingUsage}>저장</button>
            <button type="button" className="outline" disabled={saving || loadingUsage} onClick={() => { setEdit(null); setUsage(null) }}>닫기</button>
          </div>
        </form>
        {edit.id && !edit.is_system && <div className="category-usage">
          {edit.is_active ? <button type="button" className="outline" disabled={saving || loadingUsage}
            onClick={prepareDisable}>{loadingUsage ? '연결 확인 중' : '사용 중지'}</button> :
            <button type="button" className="outline" disabled={saving}
              onClick={() => submit({ action: 'category', ...edit, is_active: true }, '카테고리를 다시 사용합니다.')}>다시 사용</button>}
          {usage && <>
            <p>검토 대기 {usage.pending}건 · 확정 {usage.confirmed}건 · 예산 {usage.budgets}개 · 규칙 {usage.rules}개가 연결되어 있습니다.</p>
            <p>기존 연결은 보존되며 새 거래의 선택 목록에서 숨겨집니다.</p>
            {usage.confirmed > 0 && <a href={'/transactions?' + new URLSearchParams({ category: edit.id })}>연결된 확정 거래 보기</a>}
            <button type="button" disabled={saving} onClick={() => submit({ action: 'category', ...edit, is_active: false }, '카테고리 사용을 중지했습니다.')}>사용 중지 확인</button>
          </>}
        </div>}
      </section>}
      {groupEdit && <section className="panel" aria-labelledby="category-group-edit-title">
        <h2 id="category-group-edit-title">대분류 이름 수정</h2>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void submit({ action: 'group', ...groupEdit }, '대분류 이름을 저장했습니다.') }}>
          <label>대분류 이름<input required maxLength={80} value={groupEdit.name} disabled={saving}
            onChange={(event) => setGroupEdit({ ...groupEdit, name: event.target.value })} /></label>
          <div className="row-actions"><button type="submit" disabled={saving}>저장</button>
            <button type="button" className="outline" disabled={saving} onClick={() => setGroupEdit(null)}>닫기</button></div>
        </form>
      </section>}
      {tag && <section className="panel" aria-labelledby="tag-edit-title">
        <h2 id="tag-edit-title">{tag.id ? '태그 수정' : '태그 추가'}</h2>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void submit({ action: 'tag', ...tag }, '태그를 저장했습니다.') }}>
          <label>태그 이름<input required maxLength={24} value={tag.name} disabled={saving}
            onChange={(event) => setTag({ ...tag, name: event.target.value })} /></label>
          <div className="row-actions">
            <button type="submit" disabled={saving}>저장</button>
            <button type="button" className="outline" disabled={saving} onClick={() => setTag(null)}>닫기</button>
            {tag.id && <button type="button" className="outline" disabled={saving} onClick={() => {
              if (window.confirm('이 태그를 삭제하면 연결된 거래에서도 태그가 제거됩니다. 삭제하시겠습니까?'))
                void submit({ action: 'tag', id: tag.id, name: null }, '태그를 삭제했습니다.')
            }}>삭제</button>}
          </div>
        </form>
      </section>}
    </div>
  </>
}
