import { redirect } from 'next/navigation'

export default async function LegacyReviewPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams
  const query = new URLSearchParams({ tab: 'review' })
  if (typeof id === 'string') query.set('id', id)
  redirect('/transactions?' + query)
}
