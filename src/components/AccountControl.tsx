import { SignedIn, SignedOut, useUser, useClerk } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
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

// Signed-in control: an "Account" button (grey/white) with a small menu — Manage account (Clerk's
// hosted profile) and Sign out. Replaces Clerk's coloured avatar button. Opens upward (footer bar).
function AccountButton() {
  const clerk = useClerk()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
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
        <div className="absolute right-0 bottom-full mb-2 min-w-[10rem] rounded-md border border-stone-200 bg-white shadow-lg py-1 text-sm font-serif">
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
