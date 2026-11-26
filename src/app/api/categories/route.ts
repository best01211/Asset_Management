import type { NextRequest } from 'next/server'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { isUuid } from '@/lib/supabase/pending-expenses'
import { readPages } from '@/lib/supabase/ledger-category'
import type { CatalogCategory, CatalogTag, CategoryGroup } from '@/lib/category-catalog'

export async function GET(request: NextRequest) {
  const usageId = request.nextUrl.searchParams.get('usage')
  if (usageId !== null && !isUuid(usageId)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { user, supabase, response } = await requireFinanceUser()
  if (!supabase) return response

  if (usageId) {
    const { data, error } = await supabase.rpc('category_usage', { p_id: usageId })
    if (error) return financeRpcError(error, 'CATEGORY_USAGE_FAILED')
    return data ? financeJson(data) : financeJson({ error: 'CATEGORY_NOT_FOUND' }, 404)
  }

  const initialized = await supabase.rpc('initialize_category_catalog')
  if (initialized.error) return financeJson({ error: 'CATEGORY_CATALOG_UNAVAILABLE' }, 503)
  const tagsQuery = readPages<CatalogTag>((start, end) => supabase.from('tags').select('id,name')
    .eq('user_id', user.id).order('name').order('id').range(start, end))
  if (request.nextUrl.searchParams.get('tags') === '1') {
    const tags = await tagsQuery
    return tags ? financeJson({ tags }) : financeJson({ error: 'TAG_LIST_FAILED' }, 500)
  }
  const [groups, categories, tags] = await Promise.all([
    readPages<CategoryGroup>((start, end) => supabase.from('category_groups').select('id,name,transaction_type,sort_order')
      .eq('user_id', user.id).order('sort_order').order('id').range(start, end)),
    readPages<CatalogCategory>((start, end) => supabase.from('categories')
      .select('id,name,parent_id,transaction_type,sort_order,is_active,is_system,system_key')
      .eq('user_id', user.id).order('sort_order').order('created_at').order('id').range(start, end)),
    tagsQuery,
  ])
  return groups && categories && tags ? financeJson({ groups, categories, tags }) : financeJson({ error: 'CATEGORY_LIST_FAILED' }, 500)
}

export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!input) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const id = input.id ?? null
  const name = typeof input.name === 'string' ? input.name.trim() : null
  if (id !== null && !isUuid(id)) return financeJson({ error: 'INVALID_INPUT' }, 400)
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response

  if (input.action === 'tag') {
    if ((name === null && (id === null || input.name !== null)) ||
      (name !== null && (![...name].length || [...name].length > 24 || name.includes(','))))
      return financeJson({ error: 'INVALID_INPUT' }, 400)
    const { data, error } = await supabase.rpc('save_catalog_tag', { p_id: id, p_name: name })
    return error ? financeRpcError(error, 'TAG_SAVE_FAILED') : financeJson({ id: data })
  }

  if (input.action === 'group' && id && name && [...name].length <= 80) {
    const { data, error } = await supabase.rpc('rename_catalog_group', { p_id: id, p_name: name })
    return error ? financeRpcError(error, 'CATEGORY_GROUP_SAVE_FAILED') : financeJson({ id: data })
  }

  if (input.action === 'category' && isUuid(input.parent_id) && name && [...name].length <= 80
    && typeof input.sort_order === 'number' && Number.isInteger(input.sort_order)
    && input.sort_order >= 0 && input.sort_order <= 1000000 && typeof input.is_active === 'boolean') {
    const { data, error } = await supabase.rpc('save_catalog_category', {
      p_id: id, p_parent: input.parent_id, p_name: name, p_sort: input.sort_order, p_active: input.is_active,
    })
    return error ? financeRpcError(error, 'CATEGORY_SAVE_FAILED') : financeJson({ id: data })
  }
  return financeJson({ error: 'INVALID_INPUT' }, 400)
}
