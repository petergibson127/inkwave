// Webhook-free Clerk → Supabase email capture. Instead of configuring a Clerk webhook, the client
// pings this on sign-in with the user's Clerk id; we fetch the AUTHORITATIVE email from Clerk's
// Backend API (using the secret key — the client is never trusted for the email) and upsert the
// minimal {clerk_user_id, email} row. Content never touches this. No-ops gracefully if the Clerk
// secret or Supabase aren't configured.
//
// Spoofing note: a caller could POST someone else's Clerk id, but we only ever write that user's
// REAL email (read from Clerk), so the worst case is writing already-true data — benign. Can be
// hardened later by verifying the session token.

import { supabaseAdmin } from './_supabase.mjs'

export async function syncProfile(body) {
  const userId = body?.userId
  if (!userId) return { ok: false, error: 'missing userId' }
  const secret = process.env.CLERK_SECRET_KEY
  const sb = supabaseAdmin()
  if (!secret || !sb) return { ok: false, skipped: true } // not configured → no-op

  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    if (!res.ok) return { ok: false, error: `clerk ${res.status}` }
    const u = await res.json()
    const email =
      u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ??
      u.email_addresses?.[0]?.email_address ??
      null
    await sb.from('profiles').upsert({ clerk_user_id: userId, email }, { onConflict: 'clerk_user_id' })
    return { ok: true }
  } catch {
    return { ok: false, error: 'sync failed' }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end('Method Not Allowed')
  }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')
    const result = await syncProfile(body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result))
  } catch {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false }))
  }
}
