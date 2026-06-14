import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import OpenTimestamps from 'javascript-opentimestamps/index.js'
import { parseProof, verifyOtsProof, type BlockFetcher } from './ots'

// We build proofs with the REAL javascript-opentimestamps serializer, then verify them with our
// independent, hand-rolled reader. Lib-serialize → our-deserialize is the strongest cross-check: if
// the wire format drifts, these break.
const { DetachedTimestampFile, Ops, Timestamp, Notary } = OpenTimestamps as unknown as {
  DetachedTimestampFile: { fromHash: (op: unknown, bytes: number[]) => { timestamp: { msg: number[]; ops: Map<unknown, unknown>; attestations: unknown[] }; serializeToBytes: () => number[] } }
  Ops: { OpSHA256: new () => unknown }
  Timestamp: new (msg: number[]) => { msg: number[]; attestations: unknown[] }
  Notary: { BitcoinBlockHeaderAttestation: new (h: number) => unknown; PendingAttestation: new (uri: string) => unknown }
}

const BH = 'a'.repeat(64) // a stand-in bundleHash (32 bytes hex)
const HEIGHT = 750123
const toBytes = (hex: string) => Array.from(Buffer.from(hex, 'hex'))
const sha256 = (msg: number[]) => Array.from(createHash('sha256').update(Buffer.from(msg)).digest())
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

// A proof: bundleHash --(sha256 op)--> msg1, with a Bitcoin attestation on msg1 at HEIGHT. The block's
// merkle root (explorer/big-endian) is therefore reverse(msg1).
function buildConfirmedProof(bundleHashHex = BH, height = HEIGHT) {
  const fileDigest = toBytes(bundleHashHex)
  const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), fileDigest)
  const msg1 = sha256(fileDigest)
  const child = new Timestamp(msg1)
  child.attestations.push(new Notary.BitcoinBlockHeaderAttestation(height))
  detached.timestamp.ops.set(new Ops.OpSHA256(), child)
  return {
    proofBase64: b64(detached.serializeToBytes()),
    merkleRootBigEndian: Buffer.from(msg1.slice().reverse()).toString('hex'),
    committedMsgHex: Buffer.from(msg1).toString('hex'),
  }
}

function buildPendingProof(bundleHashHex = BH) {
  const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), toBytes(bundleHashHex))
  detached.timestamp.attestations.push(new Notary.PendingAttestation('https://a.pool.opentimestamps.org'))
  return b64(detached.serializeToBytes())
}

const blockAt = (merkleRootBigEndian: string, time = 1_700_000_000): BlockFetcher =>
  async (h) => (h === HEIGHT ? { merkleRoot: merkleRootBigEndian, time } : null)

describe('parseProof', () => {
  it('reads the file digest and Bitcoin attestation from a lib-serialized proof', async () => {
    const { proofBase64, committedMsgHex } = buildConfirmedProof()
    const parsed = await parseProof(Uint8Array.from(Buffer.from(proofBase64, 'base64')))
    expect(Buffer.from(parsed.fileDigest).toString('hex')).toBe(BH)
    const btc = parsed.attestations.find((a) => a.kind === 'bitcoin')
    expect(btc).toBeDefined()
    if (btc?.kind === 'bitcoin') {
      expect(btc.height).toBe(HEIGHT)
      expect(Buffer.from(btc.msg).toString('hex')).toBe(committedMsgHex) // msg = sha256(bundleHash)
    }
  })

  it('reads a pending calendar attestation', async () => {
    const parsed = await parseProof(Uint8Array.from(Buffer.from(buildPendingProof(), 'base64')))
    const p = parsed.attestations.find((a) => a.kind === 'pending')
    expect(p?.kind === 'pending' && p.uri).toContain('opentimestamps.org')
  })

  it('rejects non-OTS bytes', async () => {
    await expect(parseProof(new Uint8Array(40).fill(0x01))).rejects.toThrow(/bad magic/)
  })
})

describe('verifyOtsProof', () => {
  it('confirms a proof whose digest is the cited block’s merkle root', async () => {
    const { proofBase64, merkleRootBigEndian } = buildConfirmedProof()
    const r = await verifyOtsProof(proofBase64, BH, blockAt(merkleRootBigEndian))
    expect(r.status).toBe('confirmed')
    expect(r.bound).toBe(true)
    expect(r.height).toBe(HEIGHT)
    expect(r.blockTime).toBe(new Date(1_700_000_000 * 1000).toISOString())
  })

  it('rejects a proof that commits to a different bundleHash (binding)', async () => {
    const { proofBase64, merkleRootBigEndian } = buildConfirmedProof()
    const r = await verifyOtsProof(proofBase64, 'b'.repeat(64), blockAt(merkleRootBigEndian))
    expect(r.status).toBe('unverified')
    expect(r.bound).toBe(false)
    expect(r.reason).toMatch(/bundleHash/)
  })

  it('rejects when the block’s merkle root does not match the proof (forged timestamp)', async () => {
    const { proofBase64 } = buildConfirmedProof()
    const r = await verifyOtsProof(proofBase64, BH, blockAt('f'.repeat(64))) // wrong merkle root
    expect(r.status).toBe('unverified')
    expect(r.reason).toMatch(/does not match/)
  })

  it('reports pending when only a calendar attestation is present', async () => {
    const r = await verifyOtsProof(buildPendingProof(), BH, blockAt('0'.repeat(64)))
    expect(r.status).toBe('pending')
    expect(r.bound).toBe(true)
  })

  it('reports inconclusive (not a forgery) when no explorer is reachable', async () => {
    const { proofBase64 } = buildConfirmedProof()
    const r = await verifyOtsProof(proofBase64, BH, async () => null)
    expect(r.status).toBe('inconclusive')
  })

  it('treats missing proof bytes as unverified, not a crash', async () => {
    const r = await verifyOtsProof(undefined, BH, async () => null)
    expect(r.status).toBe('unverified')
    expect(r.bound).toBe(false)
  })
})
