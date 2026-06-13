import { describe, it, expect } from 'vitest'
import { verifyBundle } from './index'
import type { ExportBundle } from '../provenance/bundle'
import type { KickEvent, SignedReceipt, Snapshot, TiptapJSON } from '../types/document'
// Real server signing core (Node) — bundles are signed exactly as in production.
import { openSession, signPeriod } from '../../api/_provenance-core.mjs'
import { kicksHash, genesisPrevHash, chainHash, bitmaskToLemmas, DEV_SIGNING_PK } from '../provenance/receipts'
import { contentHash, bundleHash } from '../provenance/hash'

const DOC = 'verify-test-doc'
const CONTENT: TiptapJSON = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the writer thought about the idea today' }] }],
}

async function makeReceipt(
  token: string, counter: number, prevHash: string, ch: string, setVersion: number, kicks: KickEvent[],
): Promise<SignedReceipt> {
  const kh = await kicksHash(kicks)
  const s = await signPeriod({ sessionToken: token, docId: DOC, counter, prevHash, contentHash: ch, setVersion, kicksHash: kh })
  return {
    v: 1, sessionToken: token, counter, prevHash, contentHash: ch, setVersion,
    lockedSetHash: s.lockedSetHash, kicks, serverTime: s.serverTime, signature: s.signature, lockedSet: s.lockedSet,
  }
}

async function buildValidBundle(): Promise<ExportBundle> {
  const session = await openSession(DOC)
  const ch = await contentHash(CONTENT)

  // receipt 0 (period at set v0, no kicks)
  const prev0 = await genesisPrevHash(session.sessionToken)
  const r0 = await makeReceipt(session.sessionToken, 0, prev0, ch, 0, [])

  // receipt 1 (set v1) with an in-S kick whose lemma is genuinely in v1's signed set
  const probe = await signPeriod({ sessionToken: session.sessionToken, docId: DOC, counter: 1, prevHash: 'x', contentHash: ch, setVersion: 1, kicksHash: await kicksHash([]) })
  const memberOfV1 = [...bitmaskToLemmas(probe.lockedSet)][0]
  const kick: KickEvent = { lemma: memberOfV1, commitIndex: 0, setVersion: 1, trigger: 'in-S', response: 'swapped', replacement: 'notion', deliberationMs: 0 }
  const r1 = await makeReceipt(session.sessionToken, 1, await chainHash(r0), ch, 1, [kick])

  const receipts = [r0, r1]
  const snapshot: Snapshot = {
    id: 'snap-1', documentId: DOC, createdAt: '2026-06-13T00:00:00Z', trigger: 'kick',
    wordCount: 7, contentHash: ch, contentJson: CONTENT, receipts,
    bundleHash: await bundleHash(ch, receipts), ots: { status: 'unstamped' },
  }
  return {
    v: 1, exportedAt: '2026-06-13T00:00:00Z',
    document: { id: DOC, title: 'Test', contentJson: CONTENT, createdAt: '2026-06-13T00:00:00Z', schemaVersion: '0.1.0', scasMode: 'n', scasSetSize: 300 },
    snapshots: [snapshot], receipts,
    signingKey: { keyId: 'inkwave-signing-v1', alg: 'Ed25519', publicKeyHex: DEV_SIGNING_PK },
    poolId: 'test-pool',
  }
}

describe('verifyBundle', () => {
  it('passes a genuine bundle', async () => {
    const r = await verifyBundle(await buildValidBundle(), DEV_SIGNING_PK)
    expect(r.contentIntegrity.ok).toBe(true)
    expect(r.chain.ok).toBe(true)
    expect(r.chain.verified).toBe(2)
    expect(r.kickConsistency.ok).toBe(true)
    expect(r.friction.kicks).toBe(1)
    expect(r.overall).toBe(true)
  })

  it('fails when a snapshot content hash is wrong (content integrity)', async () => {
    const b = await buildValidBundle()
    b.snapshots[0].contentHash = 'f'.repeat(64)
    const r = await verifyBundle(b, DEV_SIGNING_PK)
    expect(r.contentIntegrity.ok).toBe(false)
    expect(r.overall).toBe(false)
  })

  it('fails when a receipt is tampered (chain breaks)', async () => {
    const b = await buildValidBundle()
    b.receipts[0].contentHash = 'a'.repeat(64)
    const r = await verifyBundle(b, DEV_SIGNING_PK)
    expect(r.chain.ok).toBe(false)
    expect(r.overall).toBe(false)
  })

  it('fails when a kick is fabricated (not in the signed set)', async () => {
    const b = await buildValidBundle()
    b.receipts[1].kicks = [{ ...b.receipts[1].kicks[0], lemma: 'zzqxfabricated' }]
    const r = await verifyBundle(b, DEV_SIGNING_PK)
    // The altered kick breaks the signature (chain) AND fails membership — both catch it.
    expect(r.overall).toBe(false)
  })

  it('rejects a genuine bundle under the wrong key', async () => {
    const r = await verifyBundle(await buildValidBundle(), 'f'.repeat(64))
    expect(r.chain.ok).toBe(false)
    expect(r.overall).toBe(false)
  })

  it('surfaces the friction score honestly', async () => {
    const r = await verifyBundle(await buildValidBundle(), DEV_SIGNING_PK)
    expect(r.friction.contentWords).toBeGreaterThan(0)
    expect(typeof r.friction.note).toBe('string')
  })
})
