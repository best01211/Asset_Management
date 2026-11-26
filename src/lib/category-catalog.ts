export type CategoryType = 'expense' | 'income'
export type CategoryOption = {
  id: string
  name: string
  group?: string
  group_order?: number
  sort_order?: number
  system_key?: string | null
  is_active?: boolean
}

export type CategoryGroup = { id: string; name: string; transaction_type: CategoryType; sort_order: number }
export type CatalogCategory = CategoryOption & {
  parent_id: string; transaction_type: CategoryType; sort_order: number; is_active: boolean; is_system: boolean
}
export type CatalogTag = { id: string; name: string }
export type Catalog = { groups: CategoryGroup[]; categories: CatalogCategory[]; tags: CatalogTag[] }
export type CategoryUsage = { pending: number; confirmed: number; budgets: number; rules: number }
export type CategoryAssignment = { sourceId: string; currentId: string; name: string }

export const categoryTypeLabels: Record<CategoryType, string> = { expense: '지출', income: '수입' }
