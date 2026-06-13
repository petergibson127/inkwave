import { SignIn } from '@clerk/clerk-react'
import { Link } from 'react-router'
import { authEnabled } from '../auth/config'

const INK = '#5c2d8a'

// /login — paid-tier sign-in (Clerk). Only relevant once auth is configured; otherwise a friendly
// note (and the free tiers never need this page).
export function AuthPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10 font-serif">
      {authEnabled() ? (
        <SignIn routing="hash" afterSignInUrl="/" afterSignUpUrl="/" />
      ) : (
        <div className="max-w-sm text-center">
          <h1 className="text-xl mb-2" style={{ color: INK }}>Sign-in isn’t enabled yet</h1>
          <p className="text-sm text-stone-500">
            Inkwave is free to write with — no account needed. Accounts arrive with the paid tier.
          </p>
          <Link to="/" className="inline-block mt-4 underline" style={{ color: '#9b5ccc' }}>← back to writing</Link>
        </div>
      )}
    </div>
  )
}
