// The SCAS constraint engine (v4 spec §4) — N-mode only for v0.1.
//
// Two responsibilities:
//   1. Derive the rotating exclusion set `S_v` from a seed (§4.2). In M0 the seed is held
//      locally on the document (a stand-in); from M3 the server holds the master secret and
//      sends the realised set + a signature. `deriveSet` is the local stand-in and the seam
//      where the server fetch slots in — keep it pure.
//   2. The ban-credit / satisfied / immunity state machine (§4.3): given the per-document
//      state overlay + whether a committed lemma is in the current S_v, decide whether the
//      commit kicks, and (on resolution) produce the next state. All PURE — the editor wires
//      events to these; the verifier replays the same functions over the logged kick events.

import { POOL, POOL_SET } from './pool'
import { getStems } from './ranking'
import type { ScasState } from '../types/document'

// ─── PRNG (mulberry32 + FNV-1a string→seed) ───────────────────────────────────
// Deterministic and dependency-free so the same (seed, docId, version) reproduces S_v
// anywhere — app, /verify page, or a standalone audit years later.

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Surface → lemma ──────────────────────────────────────────────────────────

/**
 * Resolve a typed surface word to the canonical lemma used as the membership/state key.
 * Returns the pool lemma if any stem is in P (so "runs"/"running" map to "run"); otherwise the
 * lowercased surface (an out-of-game word in N-mode — its own key, so the state machine still
 * behaves consistently if it is ever forced via the locked set).
 */
export function lemmaOf(surface: string): string {
  // Collapse inflections to one key: among the candidate stems that are in P, take the SHORTEST
  // (the most reduced base form) — so "work"/"works"/"working" share a lemma and ban-credit can't
  // be dodged by inflecting. The frequency-list pool holds inflected forms as separate entries, so
  // a surface-first rule would keep them distinct. (The crude stemmer occasionally over-collapses;
  // the real product ships a curated surface→lemma map here — this is the seam for it.)
  const w = surface.toLowerCase()
  let best: string | null = null
  for (const s of getStems(surface)) {
    if (POOL_SET.has(s) && (best === null || s.length < best.length)) best = s
  }
  return best ?? w
}

/** Is this lemma in the game at all (N-mode: rare words are out of the game)? */
export function inPool(lemma: string): boolean {
  return POOL_SET.has(lemma)
}

// ─── S_v derivation (§4.2) ──────────────────────────────────────────────────────

/**
 * Derive the exclusion set for version `v`: a `size`-element subset of P sampled with the given
 * selection `weights` (default uniform). Weighted sampling without replacement via the
 * efficient A-Res key scheme (key_i = rand^(1/w_i); take the `size` largest keys), which reduces
 * to a uniform random subset when weights are uniform.
 *
 * Pure function of (seed, docId, version) — the server can regenerate any historical S_v for
 * spot-audit and stores none of them. In M0 `seed` is the document's local `scasSeedRef`.
 *
 * @param weights optional per-pool-index selection weights (the private IP curation, supplied
 *                server-side from M3). Length must match POOL; values > 0. Omit for uniform.
 */
export function deriveSet(
  seed: string,
  docId: string,
  version: number,
  size: number,
  weights?: readonly number[],
): Set<string> {
  const n = POOL.length
  const k = Math.max(0, Math.min(size, n))
  if (k === 0) return new Set()

  const rng = mulberry32(fnv1a(`${seed}|${docId}|${version}`))

  // Compute an A-Res key per pool index, then take the k largest.
  const keys = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const u = rng()
    const w = weights ? weights[i] : 1
    // key = u^(1/w); for uniform w this is just u, giving a uniform random subset.
    keys[i] = w === 1 ? u : Math.pow(u, 1 / w)
  }

  // Indices sorted by key descending; slice the top k. (n ≈ 4,500 — a trivial sort.)
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((x, y) => keys[y] - keys[x])

  const out = new Set<string>()
  for (let i = 0; i < k; i++) out.add(POOL[order[i]])
  return out
}

// ─── The ban-credit / satisfied / immunity state machine (§4.3) ──────────────────

export type KickTrigger = 'in-S' | 'locked'

export interface CommitVerdict {
  /** Does committing this lemma right now register a constraint encounter (a kick)? */
  kicks: boolean
  /** Why it kicked (or null when it passed). 'locked' = forced regardless of S_v. */
  trigger: KickTrigger | null
}

/**
 * Decide the verdict for committing `lemma`, given the current state and whether the lemma is in
 * the current version's S_v. PURE — never mutates state, never depends on future versions, so a
 * later resample can never change an already-decided commit (no retroactive churn).
 *
 *   locked            → KICK (forced)         — a deletion debt; kicks on every commit
 *   satisfied & immune → pass                 — resolved this version; re-arms only on resample
 *   in S_v            → KICK ('in-S')         — ordinary live kick
 *   else              → pass (Dormant)
 */
export function classifyCommit(state: ScasState, lemma: string, inSv: boolean): CommitVerdict {
  if (state.locked.includes(lemma)) return { kicks: true, trigger: 'locked' }
  const sat = state.satisfied.find((s) => s.lemma === lemma)
  if (sat && sat.satisfiedAtVersion === state.version) return { kicks: false, trigger: null }
  if (inSv) return { kicks: true, trigger: 'in-S' }
  return { kicks: false, trigger: null }
}

/** Is this lemma immune (satisfied this version) right now? */
export function isImmune(state: ScasState, lemma: string): boolean {
  const sat = state.satisfied.find((s) => s.lemma === lemma)
  return !!sat && sat.satisfiedAtVersion === state.version
}

/** Is this lemma currently Locked (ban-credit outstanding)? */
export function isLocked(state: ScasState, lemma: string): boolean {
  return state.locked.includes(lemma)
}

// ── State transitions (all return a NEW state; inputs are never mutated) ─────────

/**
 * Freeze an in-S kick: record the lemma as an outstanding live kick so it stays purple across
 * S-rotation and reload without recomputing membership. Idempotent. Call when `classifyCommit`
 * returns a kick with trigger 'in-S' (locked kicks colour via the `locked` set, not this).
 */
export function recordKick(state: ScasState, lemma: string): ScasState {
  if (state.liveKicks.includes(lemma)) return state
  return { ...state, liveKicks: [...state.liveKicks, lemma] }
}

/**
 * Resolve an in-S kick *in place* (typed-and-kept, swapped, justified, or dismissed): the lemma
 * becomes Satisfied and is immune until the next resample, and stops being an outstanding kick.
 * Idempotent; refreshes immunity to the current version.
 */
export function markSatisfied(state: ScasState, lemma: string): ScasState {
  const satisfied = state.satisfied.filter((s) => s.lemma !== lemma)
  satisfied.push({ lemma, satisfiedAtVersion: state.version })
  return { ...state, satisfied, liveKicks: state.liveKicks.filter((l) => l !== lemma) }
}

/**
 * The writer deleted a kicked word (a dodge attempt) → add the lemma to the ban-credit set `B`.
 * Now it kicks on every commit regardless of S_v and is suppressed from all suggestion popovers,
 * until discharged. Clears any stale satisfied entry and the live-kick marker (it now colours via
 * `locked`). Idempotent.
 */
export function lock(state: ScasState, lemma: string): ScasState {
  const locked = state.locked.includes(lemma) ? state.locked : [...state.locked, lemma]
  const satisfied = state.satisfied.filter((s) => s.lemma !== lemma)
  return { ...state, locked, satisfied, liveKicks: state.liveKicks.filter((l) => l !== lemma) }
}

/**
 * Discharge a locked lemma: the writer typed it and completed one synonym substitution, so this
 * instance became the synonym. Remove it from `B`; it returns to Dormant (subject to ordinary
 * re-arm via rotation). No-op if not locked.
 */
export function discharge(state: ScasState, lemma: string): ScasState {
  if (!state.locked.includes(lemma)) return state
  return {
    ...state,
    locked: state.locked.filter((l) => l !== lemma),
    liveKicks: state.liveKicks.filter((l) => l !== lemma),
  }
}

/**
 * Advance to a new S-version (a resample). Immunity is keyed on the version, so satisfied entries
 * from older versions stop being immune and return to Dormant — we prune them. Locked lemmas
 * persist across resamples (the rotation is NOT the re-arm for a deletion debt). The set `S_v`
 * itself is derived separately via `deriveSet`; this only advances the overlay's version.
 */
export function resample(state: ScasState, newVersion: number): ScasState {
  return {
    ...state,
    version: newVersion,
    satisfied: state.satisfied.filter((s) => s.satisfiedAtVersion === newVersion),
  }
}
