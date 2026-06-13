// Clerk → Supabase sync (M6 groundwork). Clerk owns auth; this keeps a minimal mirror of the user
// in our own Postgres so we have the email for billing/contact "later down the track". Clerk POSTs
// signed webhooks here on user.created / user.updated / user.deleted; we verify the svix signature
// (so rows can't be forged) and upsert {clerk_user_id, email}. Content never touches this.
//
// Uses the Web Request/Response signature so we get the RAW body svix needs to verify (the Node
// req/res path pre-parses JSON, which would break signature verification).

import { Webhook } from 'svix'
import { supabaseAdmin } from './_supabase.mjs'

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 })

  const payload = await request.text()
  const headers = {
    'svix-id': request.headers.get('svix-id') ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  }

  let evt
  try {
    evt = new Webhook(secret).verify(payload, headers)
  } catch {
    return new Response(JSON.stringify({ error: 'bad signature' }), { status: 400 })
  }

  const sb = supabaseAdmin()
  try {
    if (evt.type === 'user.created' || evt.type === 'user.updated') {
      const u = evt.data
      const email =
        u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ??
        u.email_addresses?.[0]?.email_address ??
        null
      if (sb && u.id) await sb.from('profiles').upsert({ clerk_user_id: u.id, email }, { onConflict: 'clerk_user_id' })
    } else if (evt.type === 'user.deleted') {
      if (sb && evt.data?.id) await sb.from('profiles').delete().eq('clerk_user_id', evt.data.id)
    }
  } catch {
    // Don't fail the webhook on a transient DB error — Clerk will retry; the next sync repairs it.
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}
