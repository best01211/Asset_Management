// Example Next.js App Router server client. Adapt to your app's existing auth helper.
import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createClient(accessToken?: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) return null

  if (accessToken) {
    return createSupabaseClient(url, key, {
      global: { headers: { Authorization: 'Bearer ' + accessToken } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }

  const cookieStore = await cookies()
  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(items) {
          try {
            items.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Next.js may disallow setting cookies outside writable contexts.
            // Configure a token-refresh Proxy per Supabase SSR documentation.
          }
        },
      },
    }
  )
}
