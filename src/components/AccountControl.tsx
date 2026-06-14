import { SignedIn, SignedOut, useUser, useClerk } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { authEnabled } from '../auth/config'
import { useCadenceTier, startCheckout } from '../auth/entitlement'

// On sign-in, ping the webhook-free email capture once per user (the server reads the real email
// from Clerk and upserts it to Supabase). Fails silently if unconfigured. No webhook required.
function ProfileSync() {
  const { isSignedIn, user } = useUser()
  const sentFor = useRef<string | null>(null)
  useEffect(() => {
    if (!isSignedIn || !user || sentFor.current === user.id) return
    sentFor.current = user.id
    void fetch('/api/sync-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    }).catch(() => {})
  }, [isSignedIn, user])
  return null
}

// A small grey/white person glyph — matches the calm toolbar (currentColor → stone, hover purple).
function PersonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </svg>
  )
}

// Signed-in control: an "Account" button (grey/white) with a small menu — cadence status / upgrade
// (card via Stripe, or PayPal), Manage account, Sign out. Opens upward (it lives in the footer bar).
function AccountButton() {
  const clerk = useClerk()
  const { active, refresh } = useCadenceTier()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Returning from a provider redirect (?upgraded=…): re-check entitlement (webhook may lag a beat).
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.get('upgraded')) return
    url.searchParams.delete('upgraded'); url.searchParams.delete('upgrade')
    window.history.replaceState({}, '', url.toString())
    const tries = [1500, 4000, 8000]
    tries.forEach((ms) => setTimeout(() => refresh(), ms))
  }, [refresh])

  async function go(provider: 'stripe' | 'paypal') {
    setBusy(true)
    const dest = await startCheckout(provider)
    if (dest) window.location.href = dest
    else { setBusy(false); window.location.href = '/login' }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 uppercase tracking-wide text-xs font-serif text-stone-400 hover:text-[#5c2d8a] transition-colors"
      >
        <PersonIcon />
        account
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 min-w-[12rem] rounded-md border border-stone-200 bg-white shadow-lg py-1 text-sm font-serif">
          {active ? (
            <div className="px-3 py-1.5 text-[#5c2d8a]">✓ Insignia active</div>
          ) : (
            <div className="px-3 py-2 border-b border-stone-100">
              <div className="text-xs text-stone-400 mb-1.5">Insignia — $15/mo</div>
              <button type="button" disabled={busy} onClick={() => go('stripe')}
                className="block w-full text-left py-1 text-stone-700 hover:text-[#5c2d8a] disabled:opacity-50">
                Pay with card
              </button>
              <button type="button" disabled={busy} onClick={() => go('paypal')}
                className="block w-full text-left py-1 text-stone-700 hover:text-[#5c2d8a] disabled:opacity-50">
                Pay with PayPal
              </button>
            </div>
          )}
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 text-stone-600 hover:bg-stone-50 hover:text-[#5c2d8a]"
            onClick={() => { setOpen(false); clerk.openUserProfile() }}
          >
            Manage account
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 text-stone-600 hover:bg-stone-50 hover:text-[#5c2d8a]"
            onClick={() => { setOpen(false); void clerk.signOut({ redirectUrl: '/' }) }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

// Footer account control — a "Sign in" link when signed out, the Account button when signed in.
// Renders nothing (and touches no Clerk context) unless paid-tier auth is configured.
export function AccountControl() {
  if (!authEnabled()) return null
  return (
    <>
      <ProfileSync />
      <SignedOut>
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 uppercase tracking-wide text-xs transition-colors font-serif text-stone-400 hover:text-[#5c2d8a]"
        >
          <PersonIcon />
          sign in
        </Link>
      </SignedOut>
      <SignedIn>
        <AccountButton />
      </SignedIn>
    </>
  )
}
