'use client'

import { useEffect, useId, useState } from 'react'
import type { CategoryOption } from '@/lib/category-catalog'

const storageKey = 'asset-management:recent-categories'
function readRecent(): string[] {
  try {
    const items = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as unknown
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string').slice(0, 5) : []
  } catch { return [] }
}

export default function CategoryPicker({ items, value: controlled, defaultValue = '', onChange, label = '카테고리', name, required, disabled, placeholder = '소분류 선택' }: {
  items: CategoryOption[]; value?: string; defaultValue?: string; onChange?: (value: string) => void
  label?: string; name?: string; required?: boolean; disabled?: boolean; placeholder?: string
}) {
  const id = useId()
  const [search, setSearch] = useState('')
  const [internal, setInternal] = useState(defaultValue)
  const [recent, setRecent] = useState<string[]>([])
  const value = controlled ?? internal
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) setRecent(readRecent()) })
    return () => { active = false }
  }, [])
  const normalized = search.trim().toLocaleLowerCase('ko')
  const matching = items.filter((item) => (item.is_active !== false || item.id === value)
    && (!normalized || item.id === value || ((item.group ?? '') + ' ' + item.name).toLocaleLowerCase('ko').includes(normalized)))
  const groups = new Map<string, CategoryOption[]>()
  for (const item of [...matching].sort((a, b) => (a.group_order ?? 999) - (b.group_order ?? 999)
    || (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, 'ko'))) {
    const group = item.group ?? '기존 카테고리'
    const entries = groups.get(group) ?? []
    entries.push(item)
    groups.set(group, entries)
  }
  const recentItems = normalized ? [] : recent.flatMap((categoryId) => matching.find((item) => item.id === categoryId && item.is_active !== false) ?? [])

  function change(next: string) {
    if (controlled === undefined) setInternal(next)
    onChange?.(next)
    if (!next || matching.find((item) => item.id === next)?.is_active === false) return
    const nextRecent = [next, ...readRecent().filter((item) => item !== next)].slice(0, 5)
    setRecent(nextRecent)
    try { localStorage.setItem(storageKey, JSON.stringify(nextRecent)) } catch { /* Recent options are optional. */ }
  }

  return <div className="category-picker">
    <label htmlFor={id}>{label}</label>
    <input type="search" aria-label={label + ' 검색'} placeholder="대분류·소분류 검색" disabled={disabled}
      value={search} onChange={(event) => setSearch(event.target.value)} />
    <select id={id} name={name} value={value} required={required} disabled={disabled} onChange={(event) => change(event.target.value)}>
      <option value="">{placeholder}</option>
      {recentItems.length > 0 && <optgroup label="최근 선택">{recentItems.map((item) =>
        <option key={item.id} value={item.id}>{item.group ? item.group + ' → ' : ''}{item.name}</option>)}</optgroup>}
      {[...groups].map(([group, entries]) => {
        const visible = entries.filter((item) => !recentItems.some((recent) => recent.id === item.id))
        return visible.length > 0 && <optgroup key={group} label={group}>{visible.map((item) =>
          <option key={item.id} value={item.id}>{item.name}{item.is_active === false && ' (사용 중지)'}</option>)}</optgroup>
      })}
      {!matching.length && <option disabled value="no-matches">검색 결과 없음</option>}
    </select>
  </div>
}
