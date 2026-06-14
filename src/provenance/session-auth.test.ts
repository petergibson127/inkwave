import { describe, it, expect } from 'vitest'
import { openSession, handleSign, verifySessionToken } from '../../api/_provenance-core.mjs'

// The signing oracle must sign ONLY for sessions it actually opened, bound to the right docId —
// statelessly, via the keyed-MAC token. Closes the 2026-06-13 audit's unauthenticated-oracle gap.
const DOC = 'auth-test-doc'
const baseBody = (sessionToken: string, docId = DOC) => ({
  sessionToken, docId, counter: 0, prevHash: 'p', contentHash: 'c', setVersion: 0, kicksHash: 'k',
})

describe('session token authentication', () => {
  it('issues a docId-bound token that verifies for that doc only', async () => {
    const { sessionToken } = await openSession(DOC)
    expect(verifySessionToken(sessionToken, DOC)).toBe(true)
    expect(verifySessionToken(sessionToken, 'other-doc')).toBe(false)
  })

  it('rejects fabricated / malformed tokens', () => {
    expect(verifySessionToken('a'.repeat(64), DOC)).toBe(false)            // raw nonce, no MAC tag
    expect(verifySessionToken('a'.repeat(64) + '.' + 'b'.repeat(64), DOC)).toBe(false) // wrong tag
    expect(verifySessionToken('not-a-token', DOC)).toBe(false)
    expect(verifySessionToken('', DOC)).toBe(false)
  })

  it('signs a period for a genuine token (free tier)', async () => {
    const { sessionToken } = await openSession(DOC)
    const res = await handleSign(baseBody(sessionToken), undefined)
    expect(typeof res.signature).toBe('string')
    expect(res.signature.length).toBeGreaterThan(0)
  })

  it('refuses to sign for a token the server never issued', async () => {
    const forged = 'a'.repeat(64) + '.' + 'b'.repeat(64)
    await expect(handleSign(baseBody(forged), undefined)).rejects.toThrow('invalid session')
  })

  it('refuses to sign when the token is reused for a different docId', async () => {
    const { sessionToken } = await openSession(DOC)
    await expect(handleSign(baseBody(sessionToken, 'different-doc'), undefined)).rejects.toThrow('invalid session')
  })

  it('fails CLOSED in production when signing keys are unset (no silent dev-key fallback)', async () => {
    const saved = { env: process.env.VERCEL_ENV, sk: process.env.INKWAVE_SIGNING_SK, ms: process.env.INKWAVE_MASTER_SECRET }
    try {
      process.env.VERCEL_ENV = 'production'
      delete process.env.INKWAVE_SIGNING_SK
      delete process.env.INKWAVE_MASTER_SECRET
      await expect(openSession(DOC)).rejects.toThrow('signing not configured')
    } finally {
      // restore so other tests keep using the dev placeholders
      saved.env === undefined ? delete process.env.VERCEL_ENV : (process.env.VERCEL_ENV = saved.env)
      if (saved.sk !== undefined) process.env.INKWAVE_SIGNING_SK = saved.sk
      if (saved.ms !== undefined) process.env.INKWAVE_MASTER_SECRET = saved.ms
    }
  })
})
