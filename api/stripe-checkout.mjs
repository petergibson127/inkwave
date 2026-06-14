// POST /api/stripe-checkout — create a hosted Stripe Checkout session for the signed-in user's
// cadence subscription, and return its URL. The client redirects to it; card + Apple Pay + Google
// Pay all appear automatically (hosted Checkout). client_reference_id carries the Clerk user id so
// the webhook can flip the right user's subscription flag. Authed (Clerk Bearer token); no content.

import Stripe from 'stripe'
import { userFromAuth } from './_auth.mjs'

export async function createStripeCheckout(authorization, origin) {
  const user = await userFromAuth(authorization)
  if (!user) return { status: 401, body: { error: 'sign in required' } }
  const key = process.env.STRIPE_SECRET_KEY
  const price = process.env.STRIPE_PRICE_ID
  if (!key || !price) return { status: 500, body: { error: 'stripe not configured' } }
  const stripe = new Stripe(key)
  const base = origin || 'https://inkwave.studio'
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.userId,
    subscription_data: { metadata: { clerk_user_id: user.userId } },
    allow_promotion_codes: true,
    success_url: `${base}/?upgraded=stripe`,
    cancel_url: `${base}/?upgrade=cancelled`,
  })
  return { status: 200, body: { url: session.url } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
  const origin = req.headers?.origin || (req.headers?.host ? `https://${req.headers.host}` : '')
  const r = await createStripeCheckout(req.headers?.authorization || '', origin)
  res.statusCode = r.status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(r.body))
}
