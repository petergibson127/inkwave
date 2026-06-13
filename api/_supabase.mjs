// Server-side Supabase client (service role) for the /api functions. Holds ONLY the minimal user
// row (clerk_user_id, email, subscription_active) — never content. Returns null if unconfigured so
// callers degrade gracefully.

import { createClient } from '@supabase/supabase-js'

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
