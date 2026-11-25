import type { createClient } from './server'
import type { RecoveryAccount, RecoveryCategory } from '@/lib/notification-recovery'

type Supabase = NonNullable<Awaited<ReturnType<typeof createClient>>>
export type PurchaseOptions = { accounts: RecoveryAccount[]; categories: RecoveryCategory[] }

export async function purchaseOptions(supabase: Supabase, userId: string): Promise<PurchaseOptions | null> {
  const [accounts, categories] = await Promise.all([
    supabase.from('financial_accounts').select('id,name,kind,active').eq('user_id', userId)
      .eq('currency', 'KRW').in('kind', ['asset', 'liability', 'expense']).order('name'),
    supabase.from('categories').select('id,name,expense_account_id').eq('user_id', userId).order('name'),
  ])
  if (accounts.error || categories.error) return null

  const expenseAccounts = new Set(accounts.data.filter((account) => account.kind === 'expense').map((account) => account.id))
  return {
    accounts: accounts.data.filter((account) => account.active && (account.kind === 'asset' || account.kind === 'liability')),
    categories: categories.data.filter((category) => expenseAccounts.has(category.expense_account_id)),
  }
}
