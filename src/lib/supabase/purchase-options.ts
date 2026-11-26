import type { createClient } from './server'
import type { RecoveryAccount, RecoveryCategory } from '@/lib/notification-recovery'
import { readPages } from './ledger-category'

type Supabase = NonNullable<Awaited<ReturnType<typeof createClient>>>
export type PurchaseOptions = { accounts: RecoveryAccount[]; categories: RecoveryCategory[]; archivedCategories?: RecoveryCategory[] }
type CategoryRow = RecoveryCategory & { expense_account_id: string | null; parent?: { name: string; sort_order: number } | null }
type AccountRow = { id: string; name: string; kind: RecoveryAccount['kind'] | 'expense'; active: boolean }

export async function purchaseOptions(supabase: Supabase, userId: string): Promise<PurchaseOptions | null> {
  const initialized = await supabase.rpc('initialize_category_catalog')
  if (initialized.error && !['PGRST202', '42883'].includes(initialized.error.code)) return null
  const columns = initialized.error ? 'id,name,expense_account_id'
    : 'id,name,expense_account_id,is_active,sort_order,system_key,parent:category_groups!categories_same_type_group(name,sort_order)'
  const [accounts, categories] = await Promise.all([
    readPages<AccountRow>((start, end) => supabase.from('financial_accounts').select('id,name,kind,active').eq('user_id', userId)
      .eq('currency', 'KRW').in('kind', ['asset', 'liability', 'expense']).order('name').order('id').range(start, end).returns<AccountRow[]>()),
    readPages<CategoryRow>((start, end) => supabase.from('categories').select(columns)
      .eq('user_id', userId).order('name').order('id').range(start, end).returns<CategoryRow[]>()),
  ])
  if (!accounts || !categories) return null

  const expenseAccounts = new Set(accounts.filter((account) => account.kind === 'expense').map((account) => account.id))
  const options = categories.filter((category) => category.expense_account_id && expenseAccounts.has(category.expense_account_id))
    .map(({ id, name, parent, is_active, sort_order, system_key }) => ({
      id, name, group: parent?.name, group_order: parent?.sort_order, is_active, sort_order, system_key,
    }))
  return {
    accounts: accounts.flatMap((account) => account.active && (account.kind === 'asset' || account.kind === 'liability')
      ? [{ id: account.id, name: account.name, kind: account.kind }] : []),
    categories: options.filter((option) => option.is_active !== false),
    archivedCategories: options.filter((option) => option.is_active === false),
  }
}
