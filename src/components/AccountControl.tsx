import { SignedIn, SignedOut, UserButton } from '@clerk/clerk-react'
import { Link } from 'react-router'
import { authEnabled } from '../auth/config'

// Footer account control — a "Sign in" link when signed out, Clerk's user button when signed in.
// Renders nothing (and touches no Clerk context) unless paid-tier auth is configured.
export function AccountControl() {
  if (!authEnabled()) return null
  return (
    <>
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
