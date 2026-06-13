import { describe, it, expect } from 'vitest'
import type { KickEvent, SignedReceipt } from '../types/document'
import {
  verifyReceipt,
  verifyChain,
  kicksHash,
  genesisPrevHash,
  chainHash,
  bitmaskToLemmas,
  DEV_SIGNING_PK,
} from './receipts'
// The real server signing core (Node) — proves true client/server interop, not a re-implementation.
import { openSession, signPeriod, DEV_SIGNING_PK as SERVER_PK } from '../../api/_provenance-core.mjs'
import { POOL } from '../scas/pool'

const DOC = 'doc-m3-test'
const CH0 = 'a'.repeat(64)
const CH1 = 'b'.repeat(64)

// Assemble the writer-held SignedReceipt from a period's inputs + the server's signature output.
async function makeReceipt(
  session: { sessionToken: string },
  counter: number,
  prevHash: string,
  contentHash: string,
  setVersion: number,
  kicks: KickEvent[],
): Promise<SignedReceipt> {
  const kh = await kicksHash(kicks)
  const signed = await signPeriod({
    sessionToken: session.sessionToken, docId: DOC, counter, prevHash, contentHash, setVersion, kicksHash: kh,
  })
  return {
    v: 1,
    sessionToken: session.sessionToken,
    counter,
    prevHash,
    contentHash,
    setVersion,
    lockedSetHash: signed.lockedSetHash,
    kicks,
    serverTime: signed.serverTime,
    signature: signed.signature,
    lockedSet: signed.lockedSet,
  }
}

const sampleKick: KickEvent = {
  lemma: 'idea', commitIndex: 0, setVersion: 1, trigger: 'in-S', response: 'swapped', replacement: 'notion', deliberationMs: 0,
}

describe('server/client key agreement', () => {
  it('client dev pubkey matches the server core', () => {
    expect(DEV_SIGNING_PK).toBe(SERVER_PK)
  })
})

describe('single receipt', () => {
  it('verifies a genuine receipt against the published key', async () => {
    const session = await openSession(DOC)
    const prev = await genesisPrevHash(session.sessionToken)
    const r = await makeReceipt(session, 0, prev, CH0, 0, [])
    expect(await verifyReceipt(r, DEV_SIGNING_PK)).toEqual({ ok: true })
  })

  it('rejects a tampered contentHash', async () => {
    const session = await openSession(DOC)
    const prev = await genesisPrevHash(session.sessionToken)
    const r = await makeReceipt(session, 0, prev, CH0, 0, [])
    const tampered = { ...r, contentHash: CH1 }
    expect((await verifyReceipt(tampered, DEV_SIGNING_PK)).ok).toBe(false)
  })

  it('rejects an altered kick (kicksHash breaks the signature)', async () => {
    const session = await openSession(DOC)
    const prev = await genesisPrevHash(session.sessionToken)
    const r = await makeReceipt(session, 0, prev, CH0, 1, [sampleKick])
    const tampered = { ...r, kicks: [{ ...sampleKick, lemma: 'different' }] }
    expect((await verifyReceipt(tampered, DEV_SIGNING_PK)).ok).toBe(false)
  })

  it('rejects a swapped lockedSet (does not match signed hash)', async () => {
    const session = await openSession(DOC)
    const prev = await genesisPrevHash(session.sessionToken)
    const r = await makeReceipt(session, 0, prev, CH0, 0, [])
    const tampered = { ...r, lockedSet: Buffer.from(new Uint8Array(563)).toString('base64') }
    expect((await verifyReceipt(tampered, DEV_SIGNING_PK)).ok).toBe(false)
  })

  it('rejects a receipt under the wrong public key', async () => {
    const session = await openSession(DOC)
    const prev = await genesisPrevHash(session.sessionToken)
    const r = await makeReceipt(session, 0, prev, CH0, 0, [])
    const wrong = 'f'.repeat(64)
    expect((await verifyReceipt(r, wrong)).ok).toBe(false)
  })
})

describe('chain', () => {
  async function twoReceipts() {
    const session = await openSession(DOC)
    const prev0 = await genesisPrevHash(session.sessionToken)
    const r0 = await makeReceipt(session, 0, prev0, CH0, 0, [])
    const r1 = await makeReceipt(session, 1, await chainHash(r0), CH1, 1, [sampleKick])
    return { session, r0, r1 }
  }

  it('verifies a well-formed chain', async () => {
    const { session, r0, r1 } = await twoReceipts()
    expect(await verifyChain([r0, r1], session.sessionToken, DEV_SIGNING_PK)).toEqual({ ok: true, verified: 2 })
  })

  it('rejects a reordered chain', async () => {
    const { session, r0, r1 } = await twoReceipts()
    expect((await verifyChain([r1, r0], session.sessionToken, DEV_SIGNING_PK)).ok).toBe(false)
  })

  it('rejects a spliced/removed receipt', async () => {
    const { session, r0, r1 } = await twoReceipts()
    expect((await verifyChain([r0], session.sessionToken, DEV_SIGNING_PK)).ok).toBe(true) // prefix is valid
    // but r1 alone (counter 1, genesis prev) is not a valid start
    expect((await verifyChain([r1], session.sessionToken, DEV_SIGNING_PK)).ok).toBe(false)
  })
})

describe('bitmask', () => {
  it('decodes the writer-held set to ~SET_SIZE pool lemmas', async () => {
    const session = await openSession(DOC)
    const lemmas = bitmaskToLemmas(session.lockedSet)
    expect(lemmas.size).toBe(300)
    expect([...lemmas].every((w) => POOL.includes(w))).toBe(true)
  })
})
