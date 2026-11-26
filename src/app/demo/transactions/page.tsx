import { redirect } from 'next/navigation'

export default async function LegacyDemoTransactionsPage({ searchParams }: {
  searchParams: Promise<{ category?: string; month?: string; id?: string }>
}) {
  const { category, month, id } = await searchParams
  const query = new URLSearchParams({ mode: 'demo' })
  if (typeof category === 'string' && category) query.set('category', category)
  else query.set('tab', 'review')
  if (typeof month === 'string') query.set('month', month)
  if (typeof id === 'string') query.set('id', id)
  redirect('/transactions?' + query)
}
