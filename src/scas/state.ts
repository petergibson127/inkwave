// Per-document SCAS state (the ban-credit/satisfied/version overlay) — persisted in the doc JSON.
//
// The state TYPE (`ScasState`) lives in src/types/document.ts (the data model). This module owns
// the value-level concerns: sane defaults, normalisation of loaded state, a fast read model for
// the renderer, and the suggestion-suppression rule. The transition logic is in engine.ts.

import type { InkwaveDocument, ScasState } from '../types/document'
import { POOL_ID } from './pool'
import { isImmune, isLocked } from './engine'

/** Default |S| in N-mode (v4 spec §4.2: start ~300 of ~4,500). */
export const DEFAULT_SET_SIZE = 300

export function emptyScasState(): ScasState {
  return { version: 0, locked: [], satisfied: [], liveKicks: [] }
}

/** Coerce possibly-missing/partial persisted state into a valid ScasState. */
export function normalizeScasState(s: Partial<ScasState> | undefined | null): ScasState {
  if (!s) return emptyScasState()
  return {
    version: Number.isFinite(s.version) ? (s.version as number) : 0,
    locked: Array.isArray(s.locked) ? [...new Set(s.locked)] : [],
    satisfied: Array.isArray(s.satisfied)
      ? s.satisfied.filter((e) => e && typeof e.lemma === 'string')
      : [],
    liveKicks: Array.isArray(s.liveKicks) ? [...new Set(s.liveKicks)] : [],
  }
}

/**
 * Ensure a document carries the M0 SCAS fields, filling defaults without clobbering existing
 * values. Called when opening/creating a document (Edit.tsx migrateDocument) so pre-M0 docs and
 * fresh docs both end up with a valid engine state. `seedRef` defaults to the existing
 * per-document session seed (the local stand-in for the server-held seed until M3).
 */
export function withScasDefaults(doc: InkwaveDocument): InkwaveDocument {
  return {
    ...doc,
    scasMode: doc.scasMode ?? 'n',
    scasSetSize: doc.scasSetSize ?? DEFAULT_SET_SIZE,
    scasSeedRef: doc.scasSeedRef ?? doc.scasSessionSeed,
    scasPoolId: doc.scasPoolId ?? POOL_ID,
    scasState: normalizeScasState(doc.scasState),
  }
}

// ─── Fast read model for the renderer ─────────────────────────────────────────
// classifyCommit's array scans are fine at commit time (one lemma), but the decoration builder
// asks about every word on every keystroke. Build Sets once per render pass.

export interface ScasLookup {
  version: number
  locked: ReadonlySet<string>
  /** outstanding unresolved in-S kicks (frozen at commit). */
  liveKicks: ReadonlySet<string>
  /** lemmas immune at the current version (satisfied this version). */
  immune: ReadonlySet<string>
}

export function buildLookup(state: ScasState): ScasLookup {
  const immune = new Set<string>()
  for (const s of state.satisfied) {
    if (s.satisfiedAtVersion === state.version) immune.add(s.lemma)
  }
  return {
    version: state.version,
    locked: new Set(state.locked),
    liveKicks: new Set(state.liveKicks),
    immune,
  }
}

/** A lemma is coloured purple iff it is Locked (forced) or an outstanding live kick. */
export function isColoured(lookup: ScasLookup, lemma: string): boolean {
  return lookup.locked.has(lemma) || lookup.liveKicks.has(lemma)
}

/**
 * Suggestion popovers must suppress Locked lemmas (§4.3/§4.4): a locked lemma can't be acquired
 * cheaply elsewhere while its deletion debt is outstanding.
 */
export function isSuppressedFromSuggestions(state: ScasState, lemma: string): boolean {
  return isLocked(state, lemma)
}

// Re-export the per-lemma predicates so callers can use one import site for state reads.
export { isImmune, isLocked }
