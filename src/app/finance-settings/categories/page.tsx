import { redirect } from 'next/navigation'

export default function LegacyCategoriesPage() {
  redirect('/finance-settings?tab=categories')
}
