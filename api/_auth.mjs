// Verify a Clerk session token and return { userId } (or null). Used to gate the paid cadence
// tier — entitlement lookup (/api/me), checkout creation, and the sign-time cadence gate. The
// client sends the Clerk session JWT as `Authorization: Bearer <token>`; @clerk/backend verifies it
// against Clerk's published JWKS using the secret key. Never logs the token.

import { verifyToken } from '@clerk/backend'

/** Verify the bearer token from an Authorization header string → { userId } or null. */
export async function userFromAuth(authorization) {
  const secretKey = process.env.CLERK_SECRET_KEY
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : null
  if (!token || !secretKey) return null
  try {
    const claims = await verifyToken(token, { secretKey })
    return claims?.sub ? { userId: claims.sub } : null
  } catch {
    return null // invalid/expired token, or Clerk unreachable → treat as not authenticated
  }
}
