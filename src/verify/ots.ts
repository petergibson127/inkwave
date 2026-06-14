// Independent, client-side OpenTimestamps proof verifier (M5 security fix).
//
// THE GAP THIS CLOSES (2026-06-13 audit, CRITICAL): the verifier used to TRUST the author-supplied
// `ots.status` / `bitcoinBlock` / `bitcoinTime` JSON. Anyone could hand-edit those fields and /verify
// would still show "✓ checked against Bitcoin". This module instead deserialises the actual OTS proof
// BYTES, walks the commitment tree to the Bitcoin attestation, and checks the committed digest against
// the real block's merkle root fetched from INDEPENDENT block explorers (never an Inkwave server). The
// block height + time are DERIVED from the proof and the live chain, not read from the bundle.
//
// Pure + dependency-free on purpose: the Node `javascript-opentimestamps` lib fights the SPA build
// (the very reason stamping lives in a relay), and a trustless verifier shouldn't pull a black box.
// We re-implement only the minimal READ path. Wire format mirrors that lib exactly
// (detached-timestamp-file.js / timestamp.js / ops.js / notary.js), so proofs it produces verify here.

// ─── Wire constants (from the OTS spec / javascript-opentimestamps) ─────────────
// Detached-timestamp-file header magic, then varuint major version (== 1).
const HEADER_MAGIC = [
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]
// 8-byte attestation tags.
const BITCOIN_TAG = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]
const PENDING_TAG = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]
// Crypto file-hash ops → their digest byte length (sha1, ripemd160, sha256, keccak256).
const CRYPT_DIGEST_LEN: Record<number, number> = { 0x02: 20, 0x03: 20, 0x08: 32, 0x67: 32 }
const BINARY_OPS = new Set([0xf0, 0xf1]) // append, prepend (carry a varbytes arg)
const ATTESTATION = 0x00
const FORK = 0xff // "another sibling edge follows"

export class OtsParseError extends Error {}

// ─── byte helpers ───────────────────────────────────────────────────────────────
function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
function arrEq(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
function reversed(b: Uint8Array): Uint8Array {
  return b.slice().reverse()
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
async function sha256(msg: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', msg))
}

// ─── reader over the proof byte stream ──────────────────────────────────────────
class Reader {
  pos = 0
  constructor(private buf: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new OtsParseError('unexpected end of proof')
    return this.buf[this.pos++]
  }
  read(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new OtsParseError('unexpected end of proof')
    return this.buf.slice(this.pos, (this.pos += n))
  }
  // LEB128 little-endian, MSB = continuation (matches Context.readVaruint).
  varuint(): number {
    let value = 0, shift = 0, b
    do {
      b = this.byte()
      value |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return value
  }
  varbytes(): Uint8Array {
    return this.read(this.varuint())
  }
}

// ─── parsed attestations (with the message committed at each node) ──────────────
export type ProofAttestation =
  | { kind: 'bitcoin'; height: number; msg: Uint8Array }
  | { kind: 'pending'; uri: string }
  | { kind: 'unknown' }

// Apply one operation to the running message. Only the ops that appear on a Bitcoin commitment path
// are supported; anything else throws so a branch can't be silently mis-walked.
async function applyOp(tag: number, arg: Uint8Array | undefined, msg: Uint8Array): Promise<Uint8Array> {
  switch (tag) {
    case 0xf0: return concat(msg, arg!) // append
    case 0xf1: return concat(arg!, msg) // prepend
    case 0xf2: return reversed(msg)     // reverse
    case 0x08: return sha256(msg)       // sha256 (the only hash on the Bitcoin path)
    default: throw new OtsParseError(`unsupported op 0x${tag.toString(16)} on this branch`)
  }
}

// Walk the timestamp tree from `msg`, collecting every attestation with the message committed at its
// node. Mirrors Timestamp.deserialize: a run of 0xff-separated sibling edges, then a final edge; each
// edge is either an attestation (0x00) or an op whose result is the message for its own subtree. A
// branch that hits an unsupported op is recorded as 'unknown' and abandoned (it can't reach a Bitcoin
// attestation we could check) — it never aborts the other branches.
async function walk(r: Reader, msg: Uint8Array, out: ProofAttestation[]): Promise<void> {
  let tag = r.byte()
  while (tag === FORK) {
    await edge(r, r.byte(), msg, out)
    tag = r.byte()
  }
  await edge(r, tag, msg, out)
}

async function edge(r: Reader, tag: number, msg: Uint8Array, out: ProofAttestation[]): Promise<void> {
  if (tag === ATTESTATION) {
    const atag = r.read(8)
    const payload = r.varbytes()
    if (arrEq(atag, BITCOIN_TAG)) {
      out.push({ kind: 'bitcoin', height: new Reader(payload).varuint(), msg })
    } else if (arrEq(atag, PENDING_TAG)) {
      const uri = new TextDecoder().decode(new Reader(payload).varbytes())
      out.push({ kind: 'pending', uri })
    } else {
      out.push({ kind: 'unknown' })
    }
    return
  }
  const arg = BINARY_OPS.has(tag) ? r.varbytes() : undefined
  let result: Uint8Array
  try {
    result = await applyOp(tag, arg, msg)
  } catch {
    out.push({ kind: 'unknown' }) // unsupported op — abandon this branch only
    return
  }
  await walk(r, result, out)
}

/** Deserialise a detached OTS proof: its file digest (the timestamped message) + all attestations. */
export async function parseProof(bytes: Uint8Array): Promise<{ fileDigest: Uint8Array; attestations: ProofAttestation[] }> {
  const r = new Reader(bytes)
  if (!arrEq(r.read(HEADER_MAGIC.length), HEADER_MAGIC)) throw new OtsParseError('not an OpenTimestamps proof (bad magic)')
  const major = r.varuint()
  if (major !== 1) throw new OtsParseError(`unsupported OTS major version ${major}`)
  const opTag = r.byte()
  const digestLen = CRYPT_DIGEST_LEN[opTag]
  if (!digestLen) throw new OtsParseError(`unsupported file-hash op 0x${opTag.toString(16)}`)
  const fileDigest = r.read(digestLen)
  const attestations: ProofAttestation[] = []
  await walk(r, fileDigest, attestations)
  return { fileDigest, attestations }
}

// ─── independent Bitcoin block-header lookup ────────────────────────────────────
export type BlockInfo = { merkleRoot: string; time: number } // merkleRoot = explorer (big-endian) hex
export type BlockFetcher = (height: number) => Promise<BlockInfo | null>

// Esplora-compatible public explorers. Both are independent of Inkwave; requiring any two reachable
// ones to AGREE guards against a single compromised explorer. /block-height/{h} → block hash (text);
// /block/{hash} → JSON { merkle_root, timestamp }.
const EXPLORERS = [
  { name: 'mempool.space', base: 'https://mempool.space/api' },
  { name: 'blockstream.info', base: 'https://blockstream.info/api' },
]

export const defaultFetchBlock: BlockFetcher = async (height) => {
  const seen: BlockInfo[] = []
  for (const ex of EXPLORERS) {
    try {
      const hRes = await fetch(`${ex.base}/block-height/${height}`)
      if (!hRes.ok) continue
      const hash = (await hRes.text()).trim()
      if (!/^[0-9a-f]{64}$/i.test(hash)) continue
      const bRes = await fetch(`${ex.base}/block/${hash}`)
      if (!bRes.ok) continue
      const blk = (await bRes.json()) as { merkle_root?: string; timestamp?: number }
      const merkleRoot = (blk.merkle_root ?? '').toLowerCase()
      if (/^[0-9a-f]{64}$/.test(merkleRoot) && typeof blk.timestamp === 'number') {
        seen.push({ merkleRoot, time: blk.timestamp })
      }
    } catch { /* try the next explorer */ }
  }
  if (seen.length === 0) return null
  if (seen.some((b) => b.merkleRoot !== seen[0].merkleRoot || b.time !== seen[0].time)) {
    throw new OtsParseError('independent explorers disagree on this block — refusing to trust either')
  }
  return seen[0]
}

// ─── the verification entry point ───────────────────────────────────────────────
export interface OtsVerifyResult {
  // 'confirmed' = proof's digest is in a real Bitcoin block; 'pending' = only calendar attestations so
  // far; 'unverified' = a definitive failure (no binding / merkle mismatch / no Bitcoin / bad proof);
  // 'inconclusive' = couldn't reach explorers to check a Bitcoin attestation (NOT a forgery verdict).
  status: 'confirmed' | 'pending' | 'unverified' | 'inconclusive'
  bound: boolean      // does the proof actually commit to this snapshot's bundleHash?
  height?: number     // Bitcoin block height, DERIVED from the proof
  blockTime?: string  // ISO block time, DERIVED from the real block header (the durable anchor)
  reason?: string
}

/**
 * Verify a single OTS proof against Bitcoin, entirely client-side and independent of Inkwave.
 * @param proofBase64  the snapshot's ots.proofBase64
 * @param bundleHashHex the snapshot's bundleHash (what the proof MUST commit to)
 * @param fetchBlock   block-header source (defaults to public esplora explorers; injectable for tests)
 */
export async function verifyOtsProof(
  proofBase64: string | undefined,
  bundleHashHex: string,
  fetchBlock: BlockFetcher = defaultFetchBlock,
): Promise<OtsVerifyResult> {
  if (!proofBase64) return { status: 'unverified', bound: false, reason: 'no proof bytes in bundle' }

  let parsed: Awaited<ReturnType<typeof parseProof>>
  try {
    parsed = await parseProof(base64ToBytes(proofBase64))
  } catch (e) {
    return { status: 'unverified', bound: false, reason: (e as Error).message }
  }

  // Binding: the proof must timestamp THIS snapshot's bundleHash, not some other digest.
  const bound = bytesToHex(parsed.fileDigest) === bundleHashHex.toLowerCase()
  if (!bound) return { status: 'unverified', bound: false, reason: "proof does not commit to this snapshot's bundleHash" }

  const bitcoin = parsed.attestations.filter((a): a is Extract<ProofAttestation, { kind: 'bitcoin' }> => a.kind === 'bitcoin')
  if (bitcoin.length === 0) {
    const pending = parsed.attestations.some((a) => a.kind === 'pending')
    return pending
      ? { status: 'pending', bound, reason: 'awaiting Bitcoin confirmation (calendar attestation only)' }
      : { status: 'unverified', bound, reason: 'no Bitcoin attestation in proof' }
  }

  let confirmed: { height: number; time: string } | null = null
  let mismatch = false
  let unreachable = false
  for (const att of bitcoin) {
    if (att.msg.length !== 32) { mismatch = true; continue } // a Bitcoin merkle root is 32 bytes
    let block: BlockInfo | null
    try {
      block = await fetchBlock(att.height)
    } catch {
      unreachable = true
      continue
    }
    if (!block) { unreachable = true; continue }
    // OTS commits the merkle root in Bitcoin's internal (little-endian) byte order; explorers report
    // it big-endian, so reverse the explorer value before comparing.
    const explorerInternal = bytesToHex(reversed(hexToBytes(block.merkleRoot)))
    if (bytesToHex(att.msg) === explorerInternal) {
      const iso = new Date(block.time * 1000).toISOString()
      if (!confirmed || att.height < confirmed.height) confirmed = { height: att.height, time: iso }
    } else {
      mismatch = true
    }
  }

  if (confirmed) return { status: 'confirmed', bound, height: confirmed.height, blockTime: confirmed.time }
  if (mismatch) return { status: 'unverified', bound, reason: 'proof digest is not the merkle root of the cited Bitcoin block — timestamp does not match the chain' }
  if (unreachable) return { status: 'inconclusive', bound, reason: 'could not reach an independent block explorer to confirm against Bitcoin' }
  return { status: 'unverified', bound, reason: 'no verifiable Bitcoin attestation' }
}
