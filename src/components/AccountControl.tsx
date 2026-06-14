import { SignedIn, SignedOut, useUser, useClerk } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import { authEnabled } from '../auth/config'
import { useCadenceTier, startCheckout, refreshEntitlement } from '../auth/entitlement'

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

// A menu row styled to match the OptionsMenu items.
function Row({ onClick, disabled, children, muted }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode; muted?: boolean }) {
  if (muted) return <div className="px-4 py-1.5 text-xs text-stone-400">{children}</div>
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className="w-full text-left px-4 py-1.5 hover:bg-stone-100 hover:text-[#5c2d8a] transition-colors disabled:opacity-50">
      {children}
    </button>
  )
}

// Poll entitlement until it flips active (the webhook lands a beat after payment) or the popup
// closes / we time out. Runs detached from the menu, so it survives the menu closing.
function pollAfterPayment(popup: Window | null) {
  const started = Date.now()
  const timer = setInterval(async () => {
    const active = await refreshEntitlement()
    const expired = Date.now() - started > 5 * 60 * 1000
    if (active || (popup && popup.closed) || expired) {
      clearInterval(timer)
      if (active) { try { popup?.close() } catch { /* cross-origin */ } }
    }
  }, 2500)
}

// Signed-in account rows: Insignia status / get-it (popup checkout), Manage account, Sign out.
function AccountItems({ onClose }: { onClose: () => void }) {
  const clerk = useClerk()
  const { active } = useCadenceTier()
  const [busy, setBusy] = useState(false)

  function pay(provider: 'stripe' | 'paypal') {
    // Open the popup SYNCHRONOUSLY (inside the click) so it isn't blocked, then point it at the
    // provider URL once we have it. The app + this menu stay put — no full-page redirect.
    const popup = window.open('about:blank', 'inkwave-pay', 'width=480,height=760')
    setBusy(true)
    void startCheckout(provider).then((url) => {
      setBusy(false)
      if (!url) { try { popup?.close() } catch { /* noop */ }; clerk.openSignIn(); return }
      if (popup) popup.location.href = url
      pollAfterPayment(popup)
      onClose()
    })
  }

  return (
    <>
      {active ? (
        <div className="px-4 py-1.5 text-[#5c2d8a]">✓ Insignia active</div>
      ) : (
        <>
          <Row muted>Insignia — $15/mo</Row>
          <Row disabled={busy} onClick={() => pay('stripe')}>Pay with card</Row>
          <Row disabled={busy} onClick={() => pay('paypal')}>Pay with PayPal</Row>
        </>
      )}
      <Row onClick={() => { onClose(); clerk.openUserProfile() }}>Manage account</Row>
      <Row onClick={() => { onClose(); void clerk.signOut({ redirectUrl: '/' }) }}>Sign out</Row>
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
