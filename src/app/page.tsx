import Dashboard from './dashboard'
import ConnectedDashboard from './connected-dashboard'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const supabase = await createClient()
  if (!supabase) return <Dashboard />
  return <ConnectedDashboard supabase={supabase} />
}
