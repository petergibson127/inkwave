// Shared billing/entitlement core (paid cadence tier, M6). Stateless; the only thing stored is the
// per-user subscription flag in Supabase `profiles` (clerk_user_id, subscription_active, …). Never
// touches document content. Reused by /api/me, the Stripe/PayPal webhooks, and the sign-time gate.

import { userFromAuth } from './_auth.mjs'
import { supabaseAdmin } from './_supabase.mjs'

/** Is this user's cadence subscription active? Reads the flag; honours current_period_end if set. */
export async function isSubscribed(userId) {
  const sb = supabaseAdmin()
  if (!sb || !userId) return false
  const { data } = await sb
    .from('profiles')
    .select('subscription_active,current_period_end')
    .eq('clerk_user_id', userId)
    .maybeSingle()
  if (!data?.subscription_active) return false
  if (data.current_period_end && new Date(data.current_period_end).getTime() < Date.now()) return false
  return true
}

/** Entitlement for the authed caller → { cadence, userId? }. cadence=false when not signed in. */
export async function getEntitlement(authorization) {
  const user = await userFromAuth(authorization)
  if (!user) return { cadence: false }
  return { cadence: await isSubscribed(user.userId), userId: user.userId }
}

/** Upsert a subscription state for a user (called by the provider webhooks). */
export async function setSubscription(userId, { active, provider, subscriptionId, stripeCustomerId, currentPeriodEnd, email }) {
  const sb = supabaseAdmin()
  if (!sb || !userId) return
  const row = {
    clerk_user_id: userId,
    subscription_active: !!active,
    subscription_provider: provider ?? null,
    subscription_id: subscriptionId ?? null,
    updated_at: new Date().toISOString(),
  }
  if (stripeCustomerId !== undefined) row.stripe_customer_id = stripeCustomerId
  if (currentPeriodEnd !== undefined) row.current_period_end = currentPeriodEnd
  if (email !== undefined) row.email = email
  await sb.from('profiles').upsert(row, { onConflict: 'clerk_user_id' })
}
