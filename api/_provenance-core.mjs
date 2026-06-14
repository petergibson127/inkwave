// Live-composition signing core (v4 spec §4.2/§8, M3) — runs in Node (the serverless functions +
// the dev middleware share it). STATELESS and content-free: it receives only hashes, derives the
// rotating exclusion set S_v from a master secret, signs the receipt's canonical core with Ed25519,
// and forgets everything. No request/payload logging. There is no provenance database.
//
// DEV PLACEHOLDER KEYS: the signing key + master secret default to throwaway dev values so the
// whole flow is testable now. In production they come from env (INKWAVE_SIGNING_SK /
// INKWAVE_MASTER_SECRET) and the dev defaults are never used.

import * as ed from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'

// ── dev placeholders (overridden by env in prod) ────────────────────────────────
const DEV_SIGNING_SK = '5f6da0799c291ea99af6d588231ccd2db3c6cd1febbb49177d9ac5afe424e9f7'
export const DEV_SIGNING_PK = 'd5c5e5b40c2f33cb39f5c37ddc1ac27148addca4b7cdd12c7b89487a784787b4'
const DEV_MASTER_SECRET = 'inkwave-dev-master-secret-not-for-production'

// N-mode tunables (must match the client pool length; the server samples INDICES, the client maps
// them to words via its public POOL — so the server never needs the word list).
export const POOL_LEN = 4500
export const SET_SIZE = 300

const enc = new TextEncoder()
const toHex = (u) => { let s = ''; for (const b of u) s += b.toString(16).padStart(2, '0'); return s }
const fromHex = (h) => { const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u }
const b64 = (u) => Buffer.from(u).toString('base64')

// Fail CLOSED in production: the dev key/secret are committed (the public key ships in the repo), so
// silently falling back to them on a live deploy would make every signature and session MAC forgeable.
// In dev/preview/tests the placeholders are fine. Guards the signing entry points below.
function assertKeysConfigured() {
  if (process.env.VERCEL_ENV === 'production' && (!process.env.INKWAVE_SIGNING_SK || !process.env.INKWAVE_MASTER_SECRET)) {
    throw new Error('signing not configured')
  }
}

const signingKey = () => fromHex(process.env.INKWAVE_SIGNING_SK || DEV_SIGNING_SK)
const masterSecret = () => process.env.INKWAVE_MASTER_SECRET || DEV_MASTER_SECRET

export async function publicKeyHex() {
  if (process.env.INKWAVE_SIGNING_SK) return toHex(await ed.getPublicKeyAsync(signingKey()))
  return DEV_SIGNING_PK
}

function sha256Hex(s) { return toHex(sha256(enc.encode(s))) }

// RFC 8785 (JCS) subset — MUST match src/provenance/hash.ts byte-for-byte (the signature is over
// this canonical string). Integers/strings/booleans/null/objects/arrays only.
function canonicalize(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') { if (!Number.isFinite(value)) throw new Error('JCS: non-finite'); return JSON.stringify(value) }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  throw new Error('JCS: unsupported type ' + t)
}

// Seeded PRNG (mulberry32) — same family the client engine uses.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// Derive S_v as a bitmask over P (base64). Pure function of (masterSecret, docId, version): the
// server can regenerate any historical set for spot-audit and stores none of them.
function deriveBitmask(docId, version) {
  const seedHex = sha256Hex(`${masterSecret()}|${docId}|${version}`)
  const rng = mulberry32(parseInt(seedHex.slice(0, 8), 16))
  // Uniform random subset via A-Res (uniform weights → top-k of random keys). Curated weights
  // (the private IP) slot in here later; uniform for the placeholder build.
  const keys = new Array(POOL_LEN)
  for (let i = 0; i < POOL_LEN; i++) keys[i] = rng()
  const order = Array.from({ length: POOL_LEN }, (_, i) => i).sort((x, y) => keys[y] - keys[x])
  const bytes = new Uint8Array(Math.ceil(POOL_LEN / 8))
  for (let i = 0; i < SET_SIZE; i++) { const idx = order[i]; bytes[idx >> 3] |= 1 << (idx & 7) }
  return b64(bytes)
}

function lockedSetHashOf(bitmaskB64) { return sha256Hex(canonicalize(bitmaskB64)) }

function setFor(docId, version) {
  const lockedSet = deriveBitmask(docId, version)
  return { setVersion: version, lockedSet, lockedSetHash: lockedSetHashOf(lockedSet) }
}

// ── session tokens (stateless authentication) ─────────────────────────────────────
// The token is `nonce.tag`, where tag = HMAC(session subkey; docId, nonce). It carries NO identity
// (still an anonymous session) but lets the stateless signer prove — with no database — that IT
// issued the session, and that the token is bound to THIS docId. Without this the oracle would sign
// any receipt core for any client-invented token (2026-06-13 audit). The subkey is domain-separated
// from the S_v master secret so the two uses can never collide.
const SESSION_DOMAIN = 'inkwave-session-v1'
function sessionTag(docId, nonceHex) {
  const subkey = sha256(enc.encode(`${masterSecret()}|session-subkey`))
  return toHex(hmac(sha256, subkey, enc.encode(`${SESSION_DOMAIN}|${docId}|${nonceHex}`)))
}
function issueSessionToken(docId) {
  const nonceHex = toHex(ed.utils.randomSecretKey()) // 32-byte anonymous nonce
  return `${nonceHex}.${sessionTag(docId, nonceHex)}`
}
// Constant-time hex compare — never branch on where two MACs first differ.
function constTimeEqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
/** True iff `token` is one this server issued for `docId`. Pure; no state. */
export function verifySessionToken(token, docId) {
  if (typeof token !== 'string' || typeof docId !== 'string') return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const nonceHex = token.slice(0, dot)
  if (!/^[0-9a-f]{64}$/.test(nonceHex)) return false
  return constTimeEqHex(token.slice(dot + 1), sessionTag(docId, nonceHex))
}

// ── public operations ───────────────────────────────────────────────────────────

/** Open an anonymous session and issue the initial set (version 0). */
export async function openSession(docId) {
  assertKeysConfigured()
  const sessionToken = issueSessionToken(docId) // server-authenticated, docId-bound, no identity
  return { sessionToken, ...setFor(docId, 0) }
}

/**
 * Sign the receipt for a completed period and issue the next period's set (the §8 v0.1
 * one-round-trip simplification). Receives only hashes — never content, the raw set, or kick text.
 */
export async function signPeriod({ sessionToken, docId, counter, prevHash, contentHash, setVersion, kicksHash, cadenceDigest }) {
  assertKeysConfigured()
  const { lockedSet, lockedSetHash } = setFor(docId, setVersion) // re-derive → sign the TRUE set hash
  const serverTime = new Date().toISOString()
  const core = canonicalize({
    v: 1, sessionToken, counter, prevHash, contentHash, setVersion, lockedSetHash, kicksHash, serverTime,
    ...(cadenceDigest ? { cadenceDigest } : {}),
  })
  const signature = b64(await ed.signAsync(enc.encode(core), signingKey()))
  return { serverTime, signature, lockedSet, lockedSetHash, next: setFor(docId, setVersion + 1) }
}

/** Dispatch for the function + dev middleware. */
export async function handleSession(body) {
  if (typeof body?.docId !== 'string') throw new Error('bad request')
  return openSession(body.docId)
}
export async function handleSign(body, authorization) {
  for (const k of ['sessionToken', 'docId', 'prevHash', 'contentHash', 'kicksHash']) {
    if (typeof body?.[k] !== 'string') throw new Error('bad request')
  }
  // The oracle signs ONLY for sessions this server opened (and only for the docId they were opened
  // for). A fabricated or cross-doc token is refused before any signature is produced.
  if (!verifySessionToken(body.sessionToken, body.docId)) throw new Error('invalid session')
  // Insignia (paid) gate: a cadenceDigest may only be signed for an active subscriber. The free
  // tier (no cadenceDigest) is unaffected and never touches Clerk/Supabase. Lazy-imported so the
  // billing deps load only when a cadence digest is actually presented.
  if (body.cadenceDigest) {
    const [{ userFromAuth }, { isSubscribed }] = await Promise.all([
      import('./_auth.mjs'),
      import('./_billing-core.mjs'),
    ])
    const user = await userFromAuth(authorization)
    if (!user || !(await isSubscribed(user.userId))) throw new Error('subscription required')
  }
  return signPeriod(body)
}
