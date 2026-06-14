// POST /api/stripe-checkout — create an EMBEDDED Stripe Checkout session for the signed-in user's
// Insignia subscription and return its client_secret. The client mounts the checkout inline (card +
// Apple/Google Pay appear automatically); redirect_on_completion:'never' keeps it in-page. The
// webhook (client_reference_id = Clerk user id) flips the subscription flag. Authed; no content.

import Stripe from 'stripe'
import { userFromAuth } from './_auth.mjs'

export async function createStripeCheckout(authorization) {
  const user = await userFromAuth(authorization)
  if (!user) return { status: 401, body: { error: 'sign in required' } }
  const key = process.env.STRIPE_SECRET_KEY
  const price = process.env.STRIPE_PRICE_ID
  if (!key || !price) return { status: 500, body: { error: 'stripe not configured' } }
  // Pin a stable API version: the lib's default (2026-05-27) renamed ui_mode 'embedded' and breaks
  // the standard embedded Checkout that the client's stripe.initEmbeddedCheckout expects.
  const stripe = new Stripe(key, { apiVersion: '2024-06-20' })
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ui_mode: 'embedded',
    redirect_on_completion: 'never',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.userId,
    subscription_data: { metadata: { clerk_user_id: user.userId } },
  })
  return { status: 200, body: { clientSecret: session.client_secret } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
  const r = await createStripeCheckout(req.headers?.authorization || '')
  res.statusCode = r.status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(r.body))
}
