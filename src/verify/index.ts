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
//   5. anchor — REAL OTS verification: deserialize each snapshot's proof, confirm it commits to that
//      snapshot's bundleHash, and check the committed digest against the cited Bitcoin block's merkle
//      root via independent explorers. Block height/time are derived from the proof + chain, never
//      from the author's JSON; the author's claimed status/block/time are cross-checked and a lie
//      fails the bundle. We also check serverTime ≤ the verified block time (a signed timestamp can't
//      post-date the block that anchors it).
//
// HONEST LIMITATION: the full "no silent dodging" replay (every off-limits committed word has a
// resolved kick) needs the per-period content diffs; the bundle carries periodic content *hashes*
// but not per-period content, so that deeper replay is a planned extension. What's here proves the
// record is authentic, unspliceable, and internally consistent with the signed sets.

import type { ExportBundle } from '../provenance/bundle'
import type { SignedReceipt, TiptapJSON } from '../types/document'
import { canonicalize, sha256Hex, bundleHash } from '../provenance/hash'
import { verifyChain, bitmaskToLemmas, PUBLISHED_SIGNING_PK } from '../provenance/receipts'
import { cadenceDigest, BIN_MS } from '../provenance/cadence'
import { verifyOtsProof, defaultFetchBlock, type BlockFetcher } from './ots'

// A 0.5 s bin holding more than this many inserted chars (~240 chars/sec) is not human typing — it's
// a paste. Surfaced honestly; the cadence test is public and cannot carry a guarantee it can't.
const PASTE_INS_PER_BIN = Math.round((240 * BIN_MS) / 1000)

export interface VerifyReport {
  contentIntegrity: { ok: boolean; checked: number; reason?: string }
  chain: { ok: boolean; sessions: number; verified: number; reason?: string }
  kickConsistency: { ok: boolean; checked: number; reason?: string }
  friction: { kicks: number; contentWords: number; onePerWords: number | null; note: string }
  // Cadence (paid). `withDigest` counts receipts that committed a signed cadence digest; `revealed`
  // counts those whose writer-held bins are present (so we can analyse them). `integrityOk` is false
  // only when revealed bins don't match their signed digest (tamper). Plausibility is surfaced, not
  // asserted — see the spec ceiling.
  cadence: { withDigest: number; revealed: number; bins: number; ins: number; del: number; integrityOk: boolean; pasteSuspectBins: number; note: string }
  // Bitcoin anchoring, ACTUALLY verified (not trusted from the bundle's JSON). `confirmed` snapshots
  // had their proof checked against a real block's merkle root via independent explorers; `tampered`
  // is fatal (proof contradicts the chain, or the author's claimed block/time is a lie). `ok` gates
  // the bundle; `inconclusive` (couldn't reach an explorer) and `unstamped` never fail it.
  anchor: {
    snapshots: number; confirmed: number; pending: number; unstamped: number; inconclusive: number
    tampered: number; earliestBlockTime: string | null; timeConsistent: boolean; anchoredReceipts: number
    ok: boolean; note: string
  }
  // Legacy summary the /verify UI still reads — now derived from REAL verification, not the JSON.
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

// Cadence (paid): the cadenceDigest is already covered by each receipt's signature (verified in the
// chain step). Here we (a) confirm any REVEALED bins match that signed digest — so the writer-held
// bins can't be doctored after the fact — and (b) surface a plausibility read on the revealed bins.
async function verifyCadence(bundle: ExportBundle): Promise<VerifyReport['cadence']> {
  let withDigest = 0, revealed = 0, bins = 0, ins = 0, del = 0, pasteSuspectBins = 0
  let integrityOk = true
  let mismatch: string | null = null
  for (const r of bundle.receipts) {
    if (r.cadenceDigest) withDigest++
    if (!r.cadence) continue
    revealed++
    if ((await cadenceDigest(r.cadence)) !== r.cadenceDigest) { integrityOk = false; mismatch ??= `receipt ${r.counter}` }
    for (const b of r.cadence) {
      bins++; ins += b.ins; del += b.del
      if (b.ins > PASTE_INS_PER_BIN) pasteSuspectBins++
    }
  }
  const note =
    withDigest === 0 ? 'no cadence recorded (free tier or cadence not enabled)'
    : revealed === 0 ? `${withDigest} signed cadence digest(s); bins not revealed in this bundle`
    : !integrityOk ? `cadence bins do not match the signed digest (${mismatch})`
    : pasteSuspectBins > 0 ? `${pasteSuspectBins} of ${bins} bins exceed human typing speed — likely paste`
    : `${bins} bins consistent with the signed digest; no paste-speed bins`
  return { withDigest, revealed, bins, ins, del, integrityOk, pasteSuspectBins, note }
}

// REAL Bitcoin anchoring verification (the M5 security fix). For each snapshot we deserialize the OTS
// proof, confirm it commits to that snapshot's bundleHash, and check the committed digest against the
// cited block's merkle root via independent explorers. The author's claimed status/block/time are
// cross-checked — claiming a block we can't confirm, or a different block/time than the proof yields,
// is `tampered` and fails the bundle.
async function verifyAnchors(bundle: ExportBundle, fetchBlock: BlockFetcher): Promise<VerifyReport['anchor']> {
  let confirmed = 0, pending = 0, unstamped = 0, inconclusive = 0, tampered = 0
  let earliest: string | null = null
  let timeConsistent = true
  const reasons: string[] = []

  for (const s of bundle.snapshots) {
    const ots = s.ots
    // No proof bytes at all → legitimately not anchored (free tier / not yet stamped). Not a failure…
    if (!ots.proofBase64) {
      // …unless the bundle CLAIMS it's anchored without carrying a proof. That's a bare lie.
      if (ots.status === 'confirmed' || ots.status === 'pending') {
        tampered++; reasons.push(`snapshot ${s.id}: claims "${ots.status}" but carries no proof`)
      } else unstamped++
      continue
    }

    const res = await verifyOtsProof(ots.proofBase64, s.bundleHash, fetchBlock)
    if (res.status === 'confirmed') {
      confirmed++
      // Cross-check the author's claims against what the proof actually yields.
      if (ots.bitcoinBlock != null && ots.bitcoinBlock !== res.height) {
        tampered++; reasons.push(`snapshot ${s.id}: claims block ${ots.bitcoinBlock} but proof anchors to ${res.height}`)
      }
      if (res.blockTime && (!earliest || res.blockTime < earliest)) earliest = res.blockTime
      // serverTime can't post-date the block that anchors the snapshot's receipts.
      for (const r of s.receipts ?? []) {
        if (res.blockTime && r.serverTime > res.blockTime) {
          timeConsistent = false
          reasons.push(`snapshot ${s.id}: a receipt's serverTime (${r.serverTime}) is after the Bitcoin block time (${res.blockTime})`)
        }
      }
    } else if (res.status === 'pending') {
      pending++
      if (ots.status === 'confirmed') { tampered++; reasons.push(`snapshot ${s.id}: claims "confirmed" but proof is only pending`) }
    } else if (res.status === 'inconclusive') {
      inconclusive++ // couldn't reach an explorer — can't confirm, can't refute
    } else {
      // 'unverified' — a present proof that fails binding or the merkle check: tampering.
      tampered++; reasons.push(`snapshot ${s.id}: ${res.reason ?? 'proof does not verify'}`)
    }
  }

  // Informational: which verified receipts are actually committed by a snapshot (and so anchored).
  const anchored = new Set<string>()
  for (const s of bundle.snapshots) for (const r of s.receipts ?? []) anchored.add(r.signature)
  const anchoredReceipts = bundle.receipts.filter((r) => anchored.has(r.signature)).length

  const ok = tampered === 0 && timeConsistent
  const note = !ok
    ? reasons.slice(0, 3).join('; ')
    : confirmed > 0
      ? `${confirmed} snapshot(s) verified against Bitcoin${earliest ? ` (earliest block ${earliest.slice(0, 10)})` : ''}${inconclusive ? `; ${inconclusive} unconfirmable offline` : ''}`
      : pending > 0 ? `${pending} awaiting Bitcoin confirmation`
      : inconclusive > 0 ? 'could not reach a block explorer — anchoring unconfirmed'
      : 'no Bitcoin anchoring in this bundle'
  return { snapshots: bundle.snapshots.length, confirmed, pending, unstamped, inconclusive, tampered, earliestBlockTime: earliest, timeConsistent, anchoredReceipts, ok, note }
}

/**
 * Verify an export bundle end-to-end. Defaults to the INDEPENDENTLY published signing key — a
 * verifier must not trust the key the bundle carries.
 */
export async function verifyBundle(
  bundle: ExportBundle,
  pubKeyHex: string = PUBLISHED_SIGNING_PK,
  fetchBlock: BlockFetcher = defaultFetchBlock,
): Promise<VerifyReport> {
  const contentIntegrity = await checkContentIntegrity(bundle)
  const chain = await checkChains(bundle, pubKeyHex)
  const kickConsistency = checkKickConsistency(bundle)
  const friction = frictionScore(bundle)
  const cadence = await verifyCadence(bundle)
  const anchor = await verifyAnchors(bundle, fetchBlock)
  const existence = { snapshots: anchor.snapshots, confirmed: anchor.confirmed, pending: anchor.pending, unstamped: anchor.unstamped }
  // A bundle fails if content/chain/kick integrity fails, revealed cadence contradicts its signed
  // digest, OR a Bitcoin proof is forged / its claimed block/time is a lie (anchor.ok). Absent or
  // merely-unconfirmable anchoring never fails a bundle — plausibility is surfaced, not asserted.
  const overall = contentIntegrity.ok && chain.ok && kickConsistency.ok && cadence.integrityOk && anchor.ok
  return { contentIntegrity, chain, kickConsistency, friction, cadence, anchor, existence, overall }
}
