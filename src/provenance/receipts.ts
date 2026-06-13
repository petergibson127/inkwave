// Signed receipt assembly + verification (v4 spec §6/§8, M3). PURE and dependency-light (only the
// canonical hash + @noble/ed25519, which bundles cleanly in the browser) so it runs in the app, on
// the /verify page, and standalone. The guarantees rest here, not on any Inkwave UI: each receipt's
// signed core verifies against the PUBLISHED public key, and prevHash chains the receipts into one
// fixed, unspliceable sequence per session.

import * as ed from '@noble/ed25519'
import type { KickEvent, SignedReceipt } from '../types/document'
import { canonicalize, sha256Hex } from './hash'
import { POOL } from '../scas/pool'

// Dev placeholder public key (matches api/_provenance-core.mjs DEV_SIGNING_PK — used in local dev,
// where the signing service also runs on dev keys).
export const DEV_SIGNING_PK = 'd5c5e5b40c2f33cb39f5c37ddc1ac27148addca4b7cdd12c7b89487a784787b4'

// The published production signing key — also at /.well-known/inkwave-signing-key.json and committed
// to the repo, so verification never depends on inkwave.studio being online (v4 spec §8).
export const PUBLISHED_SIGNING_PK = 'b1fa2bad8ccb7451f2db3ae81851197dad5e5f6fca26297c9d6cc8e697db8b51'

/**
 * The signing public key the app verifies against: an explicit VITE_SIGNING_PK env override wins;
 * otherwise production uses the published key and local dev uses the dev placeholder (which matches
 * the dev signing service). A standalone verifier should pass the published key explicitly.
 */
export function signingPublicKeyHex(): string {
  const env = import.meta.env?.VITE_SIGNING_PK as string | undefined
  if (env) return env
  return import.meta.env?.PROD ? PUBLISHED_SIGNING_PK : DEV_SIGNING_PK
}

// ── byte helpers ─────────────────────────────────────────────────────────────
function fromHex(h: string): Uint8Array {
  const u = new Uint8Array(h.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16)
  return u
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/** Decode a period's writer-held bitmask (base64 over P) back to the set of off-limits lemmas. */
export function bitmaskToLemmas(lockedSetBase64: string): Set<string> {
  const bytes = fromBase64(lockedSetBase64)
  const out = new Set<string>()
  for (let i = 0; i < POOL.length; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) out.add(POOL[i])
  }
  return out
}

export function kicksHash(kicks: KickEvent[]): Promise<string> {
  return sha256Hex(canonicalize(kicks))
}

/** The genesis prevHash for receipt 0 of a session. */
export function genesisPrevHash(sessionToken: string): Promise<string> {
  return sha256Hex('inkwave-v1:' + sessionToken)
}

/** The chain hash of a receipt (the next receipt's prevHash must equal this). */
export function chainHash(receipt: SignedReceipt): Promise<string> {
  return sha256Hex(canonicalize(receipt))
}

// The exact bytes the server signed (client/server/verifier agree). kicksHash is recomputed from
// the receipt's kicks so altering a kick breaks the signature.
async function signedCore(r: SignedReceipt): Promise<string> {
  return canonicalize({
    v: 1,
    sessionToken: r.sessionToken,
    counter: r.counter,
    prevHash: r.prevHash,
    contentHash: r.contentHash,
    setVersion: r.setVersion,
    lockedSetHash: r.lockedSetHash,
    kicksHash: await kicksHash(r.kicks),
    serverTime: r.serverTime,
    ...(r.cadenceDigest ? { cadenceDigest: r.cadenceDigest } : {}),
  })
}

export interface ReceiptVerdict { ok: boolean; reason?: string }

/** Verify one receipt: its writer-held set matches the signed hash, and the signature is valid. */
export async function verifyReceipt(receipt: SignedReceipt, pubKeyHex: string): Promise<ReceiptVerdict> {
  // The writer-held bitmask must hash to the signed lockedSetHash (else the set was swapped).
  if (await sha256Hex(canonicalize(receipt.lockedSet)) !== receipt.lockedSetHash) {
    return { ok: false, reason: 'lockedSet does not match signed lockedSetHash' }
  }
  try {
    const core = new TextEncoder().encode(await signedCore(receipt))
    const ok = await ed.verifyAsync(fromBase64(receipt.signature), core, fromHex(pubKeyHex))
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' }
  } catch (e) {
    return { ok: false, reason: 'verify threw: ' + (e as Error).message }
  }
}

export interface ChainVerdict { ok: boolean; verified: number; reason?: string }

/**
 * Verify the whole receipt chain: counters are 0,1,2,…; each prevHash links to the prior receipt
 * (c0 = sha256("inkwave-v1:"+sessionToken)); and every signature verifies. Catches tampering,
 * reordering, splices, and altered kicks.
 */
export async function verifyChain(
  receipts: SignedReceipt[],
  sessionToken: string,
  pubKeyHex: string,
): Promise<ChainVerdict> {
  let expectedPrev = await genesisPrevHash(sessionToken)
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]
    if (r.counter !== i) return { ok: false, verified: i, reason: `counter ${r.counter} ≠ position ${i}` }
    if (r.prevHash !== expectedPrev) return { ok: false, verified: i, reason: `prevHash break at ${i}` }
    const v = await verifyReceipt(r, pubKeyHex)
    if (!v.ok) return { ok: false, verified: i, reason: `receipt ${i}: ${v.reason}` }
    expectedPrev = await chainHash(r)
  }
  return { ok: true, verified: receipts.length }
}
