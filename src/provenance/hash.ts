// Canonical hashing for the provenance spine (v4 spec §8).
//
// Everything hashed or signed must be byte-reproducible by an independent verifier years later, so
// we canonicalise with RFC 8785 (JCS) and hash with SHA-256 (lowercase hex). This module is pure
// and dependency-light on purpose: it runs in the app, on the /verify page, and standalone.

// ─── RFC 8785 (JCS) canonicalisation ──────────────────────────────────────────
// JCS: object members sorted by key (UTF-16 code-unit order), no insignificant whitespace, arrays
// in document order, strings escaped per JSON. Numbers use the ECMAScript Number→String form —
// which `JSON.stringify` already produces — so for our data (integers, strings, booleans, null,
// nested objects/arrays: TipTap JSON + receipt cores) JSON.stringify with recursively sorted keys
// IS valid JCS. (Full RFC 8785 number formatting matters only for non-integer floats, which never
// appear in what we hash; if that changes, swap in a spec-complete number serialiser here.)

export function canonicalize(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('JCS: non-finite number')
    return JSON.stringify(value) // integers + ordinary numbers match JCS via ECMAScript Number→String
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'bigint') throw new Error('JCS: bigint not supported')
  if (Array.isArray(value)) {
    return '[' + value.map((v) => serialize(v === undefined ? null : v)).join(',') + ']'
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined) // JSON/JCS omit undefined members
      .sort() // default sort = UTF-16 code-unit order, which JCS specifies
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}'
  }
  throw new Error(`JCS: unsupported type ${t}`)
}

// ─── SHA-256 ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/** Lowercase-hex SHA-256 of a UTF-8 string (WebCrypto; available in browsers and Node ≥ 20). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return toHex(digest)
}

/** sha256Hex(JCS(value)) — the canonical hash of any structured value. */
export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value))
}

// ─── Domain hashes ───────────────────────────────────────────────────────────

/** Content hash binding a snapshot to its exact ProseMirror/TipTap JSON. */
export function contentHash(contentJson: unknown): Promise<string> {
  return hashCanonical(contentJson)
}

/**
 * The Bitcoin-anchored bundle hash. Commits to the content AND the receipt chain, so a single OTS
 * proof over this attests the whole signed record. `receipts` is `[]` until M3 wires the signing
 * service; the shape is fixed now so hashes computed today verify forever.
 */
export function bundleHash(content: string, receipts: readonly unknown[] = []): Promise<string> {
  return hashCanonical({ v: 1, contentHash: content, receipts })
}
