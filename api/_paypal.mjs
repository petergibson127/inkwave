// PayPal REST helpers (sandbox or live per PAYPAL_ENV). Client-credentials token + webhook
// signature verification. No SDK — plain fetch. Never logs the secret.

export function paypalBase() {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
}

export async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_SECRET
  if (!id || !secret) return null
  const auth = Buffer.from(`${id}:${secret}`).toString('base64')
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  const j = await r.json()
  return j.access_token || null
}

// Verify a webhook came from PayPal (ask PayPal to check the signature against our webhook id).
export async function verifyPaypalWebhook(headers, rawBody) {
  const token = await paypalToken()
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!token || !webhookId) return false
  const h = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k])
  const r = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody),
    }),
  })
  const j = await r.json()
  return j.verification_status === 'SUCCESS'
}
