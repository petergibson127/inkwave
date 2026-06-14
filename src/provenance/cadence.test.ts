import { describe, it, expect } from 'vitest'
import { Schema, Slice, Fragment } from '@tiptap/pm/model'
import { ReplaceStep } from '@tiptap/pm/transform'
import { CadenceTap, countSteps, cadenceDigest, BIN_MS } from './cadence'
import { verifyBundle } from '../verify'
import type { ExportBundle } from './bundle'
import type { SignedReceipt, KeylogBin } from '../types/document'

const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } })
const insert = (n: number) => new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('x'.repeat(n))), 0, 0))
const del = (n: number) => new ReplaceStep(1, 1 + n, Slice.empty)

describe('countSteps', () => {
  it('counts inserted and deleted chars, ignores other steps', () => {
    expect(countSteps([insert(5)])).toEqual({ ins: 5, del: 0 })
    expect(countSteps([del(3)])).toEqual({ ins: 0, del: 3 })
    expect(countSteps([insert(2), del(4)])).toEqual({ ins: 2, del: 4 })
    expect(countSteps([])).toEqual({ ins: 0, del: 0 })
  })
})

describe('CadenceTap binning', () => {
  it('folds activity within one slot into a single bin', () => {
    let t = 0
    const tap = new CadenceTap(() => t)
    tap.record([insert(5)]) // t=0
    t = 100; tap.record([insert(3)])
    t = 200
    expect(tap.drain()).toEqual([{ ins: 8, del: 0 }])
  })

  it('zero-fills idle slots between activity (a pause is visible)', () => {
    let t = 0
    const tap = new CadenceTap(() => t)
    tap.record([insert(2)]) // slot 0
    t = 1200; tap.record([insert(4)]) // slot 2, after one idle slot
    t = 1300
    expect(tap.drain()).toEqual([{ ins: 2, del: 0 }, { ins: 0, del: 0 }, { ins: 4, del: 0 }])
  })

  it('resets after drain and ignores no-op transactions', () => {
    let t = 0
    const tap = new CadenceTap(() => t)
    tap.record([]) // no typing → no slot opened
    expect(tap.hasData).toBe(false)
    tap.record([insert(1)])
    expect(tap.hasData).toBe(true)
    tap.drain()
    expect(tap.hasData).toBe(false)
    expect(tap.drain()).toEqual([])
  })

  it('uses a 0.5s bin', () => { expect(BIN_MS).toBe(500) })
})

describe('cadenceDigest', () => {
  it('is deterministic for equal bins', async () => {
    const bins: KeylogBin[] = [{ ins: 3, del: 1 }, { ins: 0, del: 0 }]
    expect(await cadenceDigest(bins)).toBe(await cadenceDigest([{ ins: 3, del: 1 }, { ins: 0, del: 0 }]))
  })
  it('changes if a bin changes', async () => {
    expect(await cadenceDigest([{ ins: 3, del: 0 }])).not.toBe(await cadenceDigest([{ ins: 4, del: 0 }]))
  })
})

// Minimal bundle for the cadence portion of the verifier (chain/content checks are exercised
// elsewhere; cadence verification is independent of them).
async function bundleWith(receipts: Partial<SignedReceipt>[]): Promise<ExportBundle> {
  return {
    v: 1,
    exportedAt: '2026-01-01T00:00:00Z',
    document: { id: 'd', title: 't', contentJson: { type: 'doc', content: [] }, createdAt: '2026-01-01T00:00:00Z', schemaVersion: '1' },
    snapshots: [],
    receipts: receipts as SignedReceipt[],
    signingKey: { keyId: 'k', alg: 'Ed25519', publicKeyHex: '00' },
    poolId: 'p',
  } as ExportBundle
}

describe('verifyCadence (via verifyBundle)', () => {
  it('confirms revealed bins that match their signed digest', async () => {
    const cadence: KeylogBin[] = [{ ins: 8, del: 0 }, { ins: 6, del: 1 }]
    const r = await verifyBundle(await bundleWith([{ sessionToken: 's', counter: 0, kicks: [], lockedSet: '', cadence, cadenceDigest: await cadenceDigest(cadence) }]))
    expect(r.cadence.revealed).toBe(1)
    expect(r.cadence.withDigest).toBe(1)
    expect(r.cadence.bins).toBe(2)
    expect(r.cadence.integrityOk).toBe(true)
    expect(r.cadence.pasteSuspectBins).toBe(0)
  })

  it('fails when revealed bins do not match the signed digest (tamper)', async () => {
    const realDigest = await cadenceDigest([{ ins: 8, del: 0 }])
    const r = await verifyBundle(await bundleWith([{ sessionToken: 's', counter: 0, kicks: [], lockedSet: '', cadence: [{ ins: 99, del: 0 }], cadenceDigest: realDigest }]))
    expect(r.cadence.integrityOk).toBe(false)
    expect(r.overall).toBe(false)
  })

  it('flags paste-speed bins honestly', async () => {
    const cadence: KeylogBin[] = [{ ins: 500, del: 0 }] // ~1000 chars/sec → paste
    const r = await verifyBundle(await bundleWith([{ sessionToken: 's', counter: 0, kicks: [], lockedSet: '', cadence, cadenceDigest: await cadenceDigest(cadence) }]))
    expect(r.cadence.pasteSuspectBins).toBe(1)
    expect(r.cadence.note).toMatch(/paste/)
  })

  it('reports a free-tier bundle (no cadence) without failing', async () => {
    const r = await verifyBundle(await bundleWith([{ sessionToken: 's', counter: 0, kicks: [], lockedSet: '' }]))
    expect(r.cadence.withDigest).toBe(0)
    expect(r.cadence.integrityOk).toBe(true)
    expect(r.cadence.note).toMatch(/no cadence/)
  })
})
