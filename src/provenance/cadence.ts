// Cadence tap (v4 spec §8/§9, M6 — paid tier). Accumulates per-0.5 s INSERT/DELETE counts from
// ProseMirror steps. Privacy by construction: it records only HOW MANY characters were inserted or
// deleted in each 0.5 s slot — never which characters. The signing service only ever sees the
// cadenceDigest (a hash of the bins); the bins themselves are writer-held and revealed at the
// writer's discretion. See the spec's "honest note": hash-only cadence is a FUTURE-GATE (analysis of
// the revealed bins, now or in years), not a real-time anti-fabrication mechanism.

import { ReplaceStep } from '@tiptap/pm/transform'
import type { Step } from '@tiptap/pm/transform'
import { canonicalize, sha256Hex } from './hash'
import type { KeylogBin } from '../types/document'

export const BIN_MS = 500 // one cadence bin per 0.5 s (the default, coarse resolution)

/** The digest the server signs (and the verifier recomputes): sha256Hex(JCS(bins)). */
export function cadenceDigest(bins: KeylogBin[]): Promise<string> {
  return sha256Hex(canonicalize(bins))
}

/** Insert/delete COUNTS contributed by one transaction's steps (no characters, ever). */
export function countSteps(steps: readonly Step[]): KeylogBin {
  let ins = 0
  let del = 0
  for (const s of steps) {
    // A ReplaceStep replaces [from,to) with a slice: slice.size = inserted, (to-from) = deleted.
    // Pure insert → from===to; pure delete → slice.size===0; replacement → both. Other step kinds
    // (mark changes, etc.) carry no typing cadence and are ignored.
    if (s instanceof ReplaceStep) {
      ins += s.slice.size
      del += Math.max(0, s.to - s.from)
    }
  }
  return { ins, del }
}

// Accumulates bins across a signing period. Bucketed by ABSOLUTE wall-clock time so an idle pause
// shows up as empty bins and a paste shows up as one heavy bin — both signals the future analysis
// relies on. `clock` is injectable for tests. Call record() from onTransaction and drain() when the
// period closes (the bins for that period are attached to its signed receipt).
export class CadenceTap {
  private readonly clock: () => number
  private bins: KeylogBin[] = []
  private started = false // whether a slot has been opened since the last drain
  private slotStart = 0 // absolute ms at the start of the open slot (valid only while `started`)
  private cur: KeylogBin = { ins: 0, del: 0 }

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock
  }

  /** Fold a transaction's steps into the current 0.5 s slot (zero-filling any elapsed idle slots). */
  record(steps: readonly Step[]): void {
    const { ins, del } = countSteps(steps)
    if (ins === 0 && del === 0) return // no typing this transaction (selection, mark, decoration…)
    this.advance(this.clock())
    this.cur.ins += ins
    this.cur.del += del
  }

  // Close every slot that has fully elapsed before `now`: push the open slot, then zero bins for any
  // idle slots, leaving `cur` as the (still-open) slot that contains `now`.
  private advance(now: number): void {
    if (!this.started) {
      this.started = true
      this.slotStart = now
      return
    }
    while (now - this.slotStart >= BIN_MS) {
      this.bins.push(this.cur)
      this.cur = { ins: 0, del: 0 }
      this.slotStart += BIN_MS
    }
  }

  /** Close the period: return all bins recorded since the last drain (incl. the open slot) + reset. */
  drain(now: number = this.clock()): KeylogBin[] {
    if (this.started) {
      this.advance(now)
      this.bins.push(this.cur) // the final, still-open slot
    }
    const out = this.bins
    this.bins = []
    this.cur = { ins: 0, del: 0 }
    this.started = false
    this.slotStart = 0
    return out
  }

  /** True if anything has been recorded since the last drain (so empty periods send no digest). */
  get hasData(): boolean {
    return this.started && (this.bins.length > 0 || this.cur.ins > 0 || this.cur.del > 0)
  }
}
