// POST /api/paypal-subscribe — create a PayPal subscription for the signed-in user against our plan
// and return the approval URL (the client redirects there). custom_id carries the Clerk user id so
// the webhook can flip the right user's subscription flag. Authed (Clerk Bearer); no content.

import { userFromAuth } from './_auth.mjs'
import { paypalBase, paypalToken } from './_paypal.mjs'

export async function createPaypalSubscription(authorization, origin) {
  const user = await userFromAuth(authorization)
  if (!user) return { status: 401, body: { error: 'sign in required' } }
  const planId = process.env.PAYPAL_PLAN_ID
  const token = await paypalToken()
  if (!planId || !token) return { status: 500, body: { error: 'paypal not configured' } }
  const base = origin || 'https://inkwave.studio'
  const r = await fetch(`${paypalBase()}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: user.userId,
      application_context: {
        brand_name: 'Inkwave',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${base}/?upgraded=paypal`,
        cancel_url: `${base}/?upgrade=cancelled`,
      },
    }),
  })
  const j = await r.json()
  const approve = (j.links || []).find((l) => l.rel === 'approve')?.href
  if (!approve) return { status: 502, body: { error: 'paypal subscription failed' } }
  return { status: 200, body: { url: approve } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
  const origin = req.headers?.origin || (req.headers?.host ? `https://${req.headers.host}` : '')
  const r = await createPaypalSubscription(req.headers?.authorization || '', origin)
  res.statusCode = r.status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(r.body))
}
