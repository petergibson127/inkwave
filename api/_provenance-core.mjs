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

// ── public operations ───────────────────────────────────────────────────────────

/** Open an anonymous session and issue the initial set (version 0). */
export async function openSession(docId) {
  const sessionToken = toHex(ed.utils.randomSecretKey()) // 32-byte anonymous nonce; no identity
  return { sessionToken, ...setFor(docId, 0) }
}

/**
 * Sign the receipt for a completed period and issue the next period's set (the §8 v0.1
 * one-round-trip simplification). Receives only hashes — never content, the raw set, or kick text.
 */
export async function signPeriod({ sessionToken, docId, counter, prevHash, contentHash, setVersion, kicksHash, cadenceDigest }) {
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
export async function handleSign(body) {
  for (const k of ['sessionToken', 'docId', 'prevHash', 'contentHash', 'kicksHash']) {
    if (typeof body?.[k] !== 'string') throw new Error('bad request')
  }
  return signPeriod(body)
}
