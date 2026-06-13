import { SignIn, ClerkLoading, ClerkLoaded } from '@clerk/clerk-react'
import { Link } from 'react-router'
import { authEnabled } from '../auth/config'

const INK = '#5c2d8a'

// /login — paid-tier sign-in (Clerk). Hidden behind authEnabled() (the publishable key). When the
// key is set we render Clerk's <SignIn>, but guard it with ClerkLoading/ClerkLoaded so the page
// shows a loading state (never a blank screen) — and if it stays on "Loading…", that's the tell
// that a pk_live key can't initialise on this domain (Clerk production DNS not finished, or use the
// dev pk_test key for testing).
export function AuthPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10 font-serif">
      {authEnabled() ? (
        <>
          <ClerkLoading>
            <p className="text-sm text-stone-400">Loading sign-in…</p>
          </ClerkLoading>
          <ClerkLoaded>
            <SignIn routing="hash" fallbackRedirectUrl="/" />
          </ClerkLoaded>
        </>
      ) : (
        <div className="max-w-sm text-center">
          <h1 className="text-xl mb-2" style={{ color: INK }}>Sign-in isn’t enabled yet</h1>
          <p className="text-sm text-stone-500">
            Inkwave is free to write with — no account needed. Accounts arrive with the paid tier.
          </p>
        </div>
      )}
      <Link to="/" className="inline-block mt-6 text-sm underline" style={{ color: '#9b5ccc' }}>← back to writing</Link>
    </div>
  )
}
