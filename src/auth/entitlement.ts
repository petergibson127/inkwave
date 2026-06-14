// Client-side cadence-tier entitlement. Asks /api/me (authenticated with the Clerk session token)
// whether this user's subscription is active, and caches it for the session. The editor reads
// cadenceTierActive() to decide whether to capture + sign cadence; the server re-checks at /api/sign
// (never trust the client). Gated on auth being configured — degrades to "not subscribed" otherwise.

import { useEffect, useState } from 'react'
import { authEnabled } from './config'

type ClerkLike = { session?: { getToken?: () => Promise<string | null> } }

let cached = false
let inflight: Promise<boolean> | null = null

export async function getClerkToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const clerk = (window as unknown as { Clerk?: ClerkLike }).Clerk
  try {
    return (await clerk?.session?.getToken?.()) ?? null
  } catch {
    return null
  }
}

/** Re-fetch entitlement from the server. Returns the fresh value and updates the cache. */
export async function refreshEntitlement(): Promise<boolean> {
  if (!authEnabled()) { cached = false; return false }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const token = await getClerkToken()
      const res = await fetch('/api/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const data = (await res.json()) as { cadence?: boolean }
      cached = !!data.cadence
    } catch {
      cached = false
    } finally {
      inflight = null
    }
    return cached
  })()
  return inflight
}

/** Synchronous read of the last-known entitlement (false until refreshEntitlement resolves). */
export function cadenceTierActive(): boolean {
  return cached
}

/** Start a checkout: ask the server for a provider URL (authed) → caller redirects there. */
export async function startCheckout(provider: 'stripe' | 'paypal'): Promise<string | null> {
  const token = await getClerkToken()
  if (!token) return null // not signed in — caller should send them to /login
  const path = provider === 'stripe' ? '/api/stripe-checkout' : '/api/paypal-subscribe'
  try {
    const res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    const data = (await res.json()) as { url?: string }
    return data.url ?? null
  } catch {
    return null
  }
}

/** React hook: entitlement state, refreshed on mount (and re-checkable). */
export function useCadenceTier(): { active: boolean; loading: boolean; refresh: () => void } {
  const [active, setActive] = useState(cached)
  const [loading, setLoading] = useState(true)
  const refresh = () => {
    setLoading(true)
    refreshEntitlement().then((v) => { setActive(v); setLoading(false) })
  }
  useEffect(() => { refresh() }, [])
  return { active, loading, refresh }
}
