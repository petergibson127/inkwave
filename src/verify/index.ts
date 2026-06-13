// The open verifier (v4 spec §6, M5). PURE and framework-free — runs in the app, on the /verify
// page, and standalone. Given an export bundle it checks, entirely client-side, against the
// PUBLISHED signing key (not the key the bundle claims) and the snapshots' OTS proofs:
//
//   1. content integrity — each snapshot's contentHash matches its contentJson, and its bundleHash
//      matches (so the receipts it anchors can't be swapped);
//   2. chain — every receipt's signature verifies and prevHash links into one unspliceable sequence
//      per session (catches tamper / reorder / splice / altered kicks);
//   3. kick consistency — every logged in-S kick's lemma was actually in that period's SIGNED set
//      (decode the bitmask) — a fabricated kick log can't match the signed sets;
//   4. friction — observed kicks ÷ content words, surfaced honestly against a plausibility floor;
//   5. existence — tally the OTS → Bitcoin anchoring state across snapshots.
//
// HONEST LIMITATION: the full "no silent dodging" replay (every off-limits committed word has a
// resolved kick) needs the per-period content diffs; the bundle carries periodic content *hashes*
// but not per-period content, so that deeper replay is a planned extension. What's here proves the
// record is authentic, unspliceable, and internally consistent with the signed sets.

import type { ExportBundle } from '../provenance/bundle'
import type { SignedReceipt, TiptapJSON } from '../types/document'
import { canonicalize, sha256Hex, bundleHash } from '../provenance/hash'
import { verifyChain, bitmaskToLemmas, PUBLISHED_SIGNING_PK } from '../provenance/receipts'

export interface VerifyReport {
  contentIntegrity: { ok: boolean; checked: number; reason?: string }
  chain: { ok: boolean; sessions: number; verified: number; reason?: string }
  kickConsistency: { ok: boolean; checked: number; reason?: string }
  friction: { kicks: number; contentWords: number; onePerWords: number | null; note: string }
  existence: { snapshots: number; confirmed: number; pending: number; unstamped: number }
  overall: boolean
}

function countWords(contentJson: TiptapJSON): number {
  let text = ''
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string') text += n.text + ' '
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(contentJson)
  const m = text.trim().match(/[\p{L}\p{N}]+/gu)
  return m ? m.length : 0
}

async function checkContentIntegrity(bundle: ExportBundle): Promise<VerifyReport['contentIntegrity']> {
  let checked = 0
  for (const s of bundle.snapshots) {
    checked++
    const ch = await sha256Hex(canonicalize(s.contentJson))
    if (ch !== s.contentHash) return { ok: false, checked, reason: `snapshot ${s.id}: contentHash mismatch` }
    const bh = await bundleHash(s.contentHash, s.receipts ?? [])
    if (bh !== s.bundleHash) return { ok: false, checked, reason: `snapshot ${s.id}: bundleHash mismatch` }
  }
  return { ok: true, checked }
}

async function checkChains(bundle: ExportBundle, pubKeyHex: string): Promise<VerifyReport['chain']> {
  const bySession = new Map<string, SignedReceipt[]>()
  for (const r of bundle.receipts) {
    const arr = bySession.get(r.sessionToken) ?? []
    arr.push(r)
    bySession.set(r.sessionToken, arr)
  }
  let verified = 0
  for (const [token, receipts] of bySession) {
    receipts.sort((a, b) => a.counter - b.counter)
    const v = await verifyChain(receipts, token, pubKeyHex)
    if (!v.ok) return { ok: false, sessions: bySession.size, verified, reason: v.reason }
    verified += v.verified
  }
  return { ok: true, sessions: bySession.size, verified }
}

function checkKickConsistency(bundle: ExportBundle): VerifyReport['kickConsistency'] {
  let checked = 0
  for (const r of bundle.receipts) {
    const sv = bitmaskToLemmas(r.lockedSet)
    for (const k of r.kicks) {
      checked++
      // 'locked' kicks are forced regardless of S; only in-S kicks must be members of the signed set.
      if (k.trigger === 'in-S' && !sv.has(k.lemma)) {
        return { ok: false, checked, reason: `kick "${k.lemma}" not in signed set v${r.setVersion}` }
      }
    }
  }
  return { ok: true, checked }
}

function frictionScore(bundle: ExportBundle): VerifyReport['friction'] {
  const kicks = bundle.receipts.reduce((n, r) => n + r.kicks.length, 0)
  const contentWords = countWords(bundle.document.contentJson)
  const onePerWords = kicks > 0 ? Math.round(contentWords / kicks) : null
  // A document with implausibly little friction proves little — surface the number, don't hide it.
  const note =
    kicks === 0 ? 'no kicks recorded — proves little about live composition'
    : onePerWords && onePerWords > 200 ? `low friction (~1 kick per ${onePerWords} words)`
    : `~1 kick per ${onePerWords} words`
  return { kicks, contentWords, onePerWords, note }
}

function existenceTally(bundle: ExportBundle): VerifyReport['existence'] {
  let confirmed = 0, pending = 0, unstamped = 0
  for (const s of bundle.snapshots) {
    if (s.ots.status === 'confirmed') confirmed++
    else if (s.ots.status === 'pending') pending++
    else unstamped++
  }
  return { snapshots: bundle.snapshots.length, confirmed, pending, unstamped }
}

/**
 * Verify an export bundle end-to-end. Defaults to the INDEPENDENTLY published signing key — a
 * verifier must not trust the key the bundle carries.
 */
export async function verifyBundle(bundle: ExportBundle, pubKeyHex: string = PUBLISHED_SIGNING_PK): Promise<VerifyReport> {
  const contentIntegrity = await checkContentIntegrity(bundle)
  const chain = await checkChains(bundle, pubKeyHex)
  const kickConsistency = checkKickConsistency(bundle)
  const friction = frictionScore(bundle)
  const existence = existenceTally(bundle)
  const overall = contentIntegrity.ok && chain.ok && kickConsistency.ok
  return { contentIntegrity, chain, kickConsistency, friction, existence, overall }
}
