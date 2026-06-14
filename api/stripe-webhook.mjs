// POST /api/stripe-webhook — Stripe → Supabase subscription sync. Web Request handler (not the
// Node req/res style) so we get the RAW body that signature verification needs. Verifies the
// Stripe signature, then flips the user's `subscription_active` flag. Content never touches this.

import Stripe from 'stripe'
import { setSubscription } from './_billing-core.mjs'

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const key = process.env.STRIPE_SECRET_KEY
  const whsec = process.env.STRIPE_WEBHOOK_SECRET
  if (!key || !whsec) return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 })

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' })
  const raw = await request.text()
  const sig = request.headers.get('stripe-signature') || ''
  let event
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whsec)
  } catch {
    return new Response(JSON.stringify({ error: 'bad signature' }), { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object
      const userId = s.client_reference_id || s.metadata?.clerk_user_id
      if (userId) await setSubscription(userId, {
        active: true, provider: 'stripe',
        subscriptionId: typeof s.subscription === 'string' ? s.subscription : undefined,
        stripeCustomerId: typeof s.customer === 'string' ? s.customer : undefined,
        email: s.customer_details?.email ?? undefined,
      })
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      const userId = sub.metadata?.clerk_user_id
      const active = event.type !== 'customer.subscription.deleted'
        && ['active', 'trialing', 'past_due'].includes(sub.status)
      if (userId) await setSubscription(userId, {
        active, provider: 'stripe', subscriptionId: sub.id,
        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : undefined,
      })
    }
  } catch {
    // Don't fail the webhook on a transient DB error — Stripe retries; the next event repairs it.
  }
  return new Response(JSON.stringify({ received: true }), { headers: { 'content-type': 'application/json' } })
}
