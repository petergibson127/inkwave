import { SignedIn, SignedOut, useUser, useClerk } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { authEnabled } from '../auth/config'
import { useCadenceTier, stripeClientSecret, paypalApproveUrl, refreshEntitlement } from '../auth/entitlement'

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

function Row({ onClick, disabled, children }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className="w-full text-left px-4 py-1.5 hover:bg-stone-100 hover:text-[#5c2d8a] transition-colors disabled:opacity-50">
      {children}
    </button>
  )
}

// Poll entitlement until it flips active (the webhook lands a beat after payment), then run onActive.
// Detached from the menu/modal so it survives them closing.
function pollAfterPayment(onActive: () => void) {
  const started = Date.now()
  const timer = setInterval(async () => {
    const active = await refreshEntitlement()
    if (active || Date.now() - started > 5 * 60 * 1000) {
      clearInterval(timer)
      if (active) onActive()
    }
  }, 2500)
}

// ─── Stripe.js loader (script tag — no npm package) ─────────────────────────────
type StripeEmbedded = { mount: (el: HTMLElement) => void; destroy: () => void }
type StripeObj = { initEmbeddedCheckout: (o: { clientSecret: string; onComplete?: () => void }) => Promise<StripeEmbedded> }
let stripeJs: Promise<StripeObj | null> | null = null
function loadStripe(pk: string): Promise<StripeObj | null> {
  if (stripeJs) return stripeJs
  stripeJs = new Promise((resolve, reject) => {
    const w = window as unknown as { Stripe?: (k: string) => StripeObj }
    if (w.Stripe) return resolve(w.Stripe(pk))
    const s = document.createElement('script')
    s.src = 'https://js.stripe.com/v3'
    s.async = true
    s.onload = () => resolve(w.Stripe ? w.Stripe(pk) : null)
    s.onerror = () => reject(new Error('Stripe.js load failed'))
    document.head.appendChild(s)
  })
  return stripeJs
}

// In-page Insignia checkout — opens from the menu. Shows the price + two options; "Pay with card"
// mounts Stripe's embedded Checkout inline; "Pay with PayPal" opens PayPal's own approval popup
// (PayPal can't embed). × closes it. On completion it polls entitlement and closes itself.
function InsigniaModal({ onClose }: { onClose: () => void }) {
  const PK = import.meta.env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const checkoutRef = useRef<StripeEmbedded | null>(null)

  // Mount Stripe's embedded Checkout straight away (card + Apple/Google Pay) when the modal opens.
  useEffect(() => {
    if (!PK || done) return
    let cancelled = false
    void (async () => {
      const secret = await stripeClientSecret()
      const stripe = secret ? await loadStripe(PK) : null
      if (!secret || !stripe || cancelled || !cardRef.current) return
      const checkout = await stripe.initEmbeddedCheckout({
        clientSecret: secret,
        onComplete: () => { setDone(true); pollAfterPayment(onClose) },
      })
      if (cancelled || !cardRef.current) { try { checkout.destroy() } catch { /* noop */ }; return }
      checkoutRef.current = checkout
      checkout.mount(cardRef.current)
    })()
    return () => { cancelled = true; try { checkoutRef.current?.destroy() } catch { /* noop */ } checkoutRef.current = null }
  }, [PK, done, onClose])

  function payPaypal() {
    // Open the popup SYNCHRONOUSLY (inside the click) so it isn't blocked, then point it at PayPal's
    // approval URL once we have it. PayPal can't embed, so it's a link out to PayPal's own popup.
    const popup = window.open('about:blank', 'inkwave-pay', 'width=460,height=820')
    setBusy(true)
    void paypalApproveUrl().then((url) => {
      setBusy(false)
      if (!url) { try { popup?.close() } catch { /* noop */ } return }
      if (popup) popup.location.href = url
      pollAfterPayment(onClose)
      onClose()
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-stone-900/20" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Insignia" onMouseDown={(e) => e.stopPropagation()}
        className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md max-h-[85vh] overflow-auto font-serif">
        <button type="button" aria-label="Close" onClick={onClose}
          className="absolute top-3 right-3 text-stone-400 hover:text-[#5c2d8a] text-2xl leading-none z-10">×</button>
        <h2 className="text-lg text-[#5c2d8a] text-center">Insignia</h2>
        <p className="text-sm text-stone-500 text-center mb-4">$15 AUD per month</p>
        {done ? (
          <p className="text-center text-[#5c2d8a] py-10">✓ Payment received — activating Insignia…</p>
        ) : (
          <>
            {PK
              ? <div ref={cardRef} className="min-h-[18rem]" />
              : <p className="text-xs text-amber-600 text-center py-6">Card checkout needs VITE_STRIPE_PUBLISHABLE_KEY in .env.</p>}
            <div className="text-center mt-3">
              <button type="button" disabled={busy} onClick={payPaypal}
                className="text-sm text-stone-500 underline hover:text-[#5c2d8a] disabled:opacity-50">
                or pay with PayPal
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

// Signed-in account rows.
function AccountItems({ onClose }: { onClose: () => void }) {
  const clerk = useClerk()
  const { active } = useCadenceTier()
  const [showInsignia, setShowInsignia] = useState(false)
  return (
    <>
      {active
        ? <div className="px-4 py-1.5 text-[#5c2d8a]">✓ Insignia active</div>
        : <Row onClick={() => setShowInsignia(true)}>Insignia</Row>}
      <Row onClick={() => { onClose(); clerk.openUserProfile() }}>Account</Row>
      <Row onClick={() => { onClose(); void clerk.signOut({ redirectUrl: '/' }) }}>Sign out</Row>
      {showInsignia && <InsigniaModal onClose={() => { setShowInsignia(false); onClose() }} />}
    </>
  )
}

function SignInItem({ onClose }: { onClose: () => void }) {
  const clerk = useClerk()
  return <Row onClick={() => { onClose(); clerk.openSignIn() }}>Sign in</Row>
}

// Account section for the OptionsMenu (hamburger) — sits alongside Save/Open. Sign-in when signed
// out; Insignia + account actions when signed in. Renders nothing unless paid-tier auth is set up.
export function AccountMenuItems({ onClose }: { onClose: () => void }) {
  if (!authEnabled()) return null
  return (
    <>
      <div className="my-1 border-t border-stone-100" />
      <ProfileSync />
      <SignedOut><SignInItem onClose={onClose} /></SignedOut>
      <SignedIn><AccountItems onClose={onClose} /></SignedIn>
    </>
  )
}
