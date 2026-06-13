import { SignedIn, SignedOut, UserButton, useUser } from '@clerk/clerk-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { authEnabled } from '../auth/config'

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

// Footer account control — a "Sign in" link when signed out, Clerk's user button when signed in.
// Renders nothing (and touches no Clerk context) unless paid-tier auth is configured.
export function AccountControl() {
  if (!authEnabled()) return null
  return (
    <>
      <ProfileSync />
      <SignedOut>
        <Link
          to="/login"
          className="uppercase tracking-wide text-xs transition-colors font-serif text-stone-400 hover:text-[#5c2d8a]"
        >
          sign in
        </Link>
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </>
  )
}
