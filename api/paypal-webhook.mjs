// POST /api/paypal-webhook — PayPal → Supabase subscription sync. Web Request handler (raw body for
// signature verification). Verifies with PayPal, then flips the user's `subscription_active` flag
// (custom_id = Clerk user id, set at subscription creation). Content never touches this.

import { verifyPaypalWebhook } from './_paypal.mjs'
import { setSubscription } from './_billing-core.mjs'

const ACTIVATE = new Set(['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED'])
const DEACTIVATE = new Set(['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.SUSPENDED'])

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const raw = await request.text()
  const ok = await verifyPaypalWebhook(request.headers, raw)
  if (!ok) return new Response(JSON.stringify({ error: 'bad signature' }), { status: 400 })
  try {
    const event = JSON.parse(raw)
    const resource = event.resource || {}
    const userId = resource.custom_id
    if (userId) {
      if (ACTIVATE.has(event.event_type)) {
        await setSubscription(userId, { active: true, provider: 'paypal', subscriptionId: resource.id })
      } else if (DEACTIVATE.has(event.event_type)) {
        await setSubscription(userId, { active: false, provider: 'paypal', subscriptionId: resource.id })
      }
    }
  } catch {
    // transient DB error → PayPal retries; the next event repairs it.
  }
  return new Response(JSON.stringify({ received: true }), { headers: { 'content-type': 'application/json' } })
}
