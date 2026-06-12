import { describe, it, expect } from 'vitest'
import {
  deriveSet,
  lemmaOf,
  inPool,
  classifyCommit,
  recordKick,
  markSatisfied,
  lock,
  discharge,
  resample,
  isLocked,
  isImmune,
} from './engine'
import { emptyScasState, buildLookup, isColoured, isSuppressedFromSuggestions } from './state'
import { POOL, POOL_SET } from './pool'
import type { ScasState } from '../types/document'

const SEED = 'test-seed-abc'
const DOC = 'doc-123'

describe('pool', () => {
  it('is non-empty, deduped, and all lowercase alphabetic', () => {
    expect(POOL.length).toBeGreaterThan(1000)
    expect(new Set(POOL).size).toBe(POOL.length)
    expect(POOL.every((w) => /^[a-z]+$/.test(w) && w.length >= 3)).toBe(true)
  })
  it('excludes function words', () => {
    for (const fw of ['the', 'and', 'with', 'their', 'would', 'about']) {
      expect(POOL_SET.has(fw)).toBe(false)
    }
  })
})

describe('deriveSet (S_v derivation)', () => {
  it('is deterministic for the same (seed, docId, version)', () => {
    const a = deriveSet(SEED, DOC, 0, 300)
    const b = deriveSet(SEED, DOC, 0, 300)
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('rotates: a different version yields a substantially different set', () => {
    const v0 = deriveSet(SEED, DOC, 0, 300)
    const v1 = deriveSet(SEED, DOC, 1, 300)
    expect([...v0].sort()).not.toEqual([...v1].sort())
    const overlap = [...v0].filter((w) => v1.has(w)).length
    // Two random 300-of-4500 subsets overlap ≈ 300·300/4500 ≈ 20 on average; assert it's far
    // from identical (a regression that ignored the version would give full overlap = 300).
    expect(overlap).toBeLessThan(120)
  })

  it('respects size and stays within the pool', () => {
    const s = deriveSet(SEED, DOC, 0, 300)
    expect(s.size).toBe(300)
    expect([...s].every((w) => POOL_SET.has(w))).toBe(true)
  })

  it('is doc-scoped: a different docId yields a different set', () => {
    const a = deriveSet(SEED, 'doc-A', 0, 300)
    const b = deriveSet(SEED, 'doc-B', 0, 300)
    expect([...a].sort()).not.toEqual([...b].sort())
  })
})

describe('lemmaOf (surface → lemma)', () => {
  it('maps inflections to their pool lemma', () => {
    expect(POOL_SET.has('work')).toBe(true)
    expect(lemmaOf('working')).toBe('work')
    expect(lemmaOf('works')).toBe('work')
    expect(lemmaOf('Work')).toBe('work')
  })
  it('returns the lowercased surface for out-of-pool words', () => {
    expect(inPool('zzqxnonsense')).toBe(false)
    expect(lemmaOf('ZZQXnonsense')).toBe('zzqxnonsense')
  })
})

// Pick a lemma guaranteed to be in S_v for the version under test, so the kick path is exercised
// deterministically regardless of which words the sampler happens to choose.
function aMemberOf(version: number): string {
  return [...deriveSet(SEED, DOC, version, 300)][0]
}

describe('ban-credit state machine (§4.3)', () => {
  it('Dormant: a lemma not in S, not locked, not satisfied → passes', () => {
    const s = emptyScasState()
    expect(classifyCommit(s, 'somelemma', false)).toEqual({ kicks: false, trigger: null })
  })

  it('in-S → kicks with trigger "in-S"', () => {
    const s = emptyScasState()
    expect(classifyCommit(s, 'anything', true)).toEqual({ kicks: true, trigger: 'in-S' })
  })

  it('resolve-in-place → satisfied → immune this version (no re-kick even if still in S)', () => {
    let s = emptyScasState()
    const L = 'idea'
    expect(classifyCommit(s, L, true).kicks).toBe(true) // first encounter kicks
    s = markSatisfied(s, L)
    expect(isImmune(s, L)).toBe(true)
    expect(classifyCommit(s, L, true)).toEqual({ kicks: false, trigger: null }) // immune
  })

  it('satisfied words re-kick after the next resample', () => {
    let s = emptyScasState()
    const L = 'idea'
    s = markSatisfied(s, L)
    expect(classifyCommit(s, L, true).kicks).toBe(false) // immune at v0
    s = resample(s, 1)
    expect(isImmune(s, L)).toBe(false) // immunity expired with the version
    expect(classifyCommit(s, L, true)).toEqual({ kicks: true, trigger: 'in-S' })
  })

  it('deleting a kicked word locks it → forced kick on retype regardless of S', () => {
    let s = emptyScasState()
    const L = 'concept'
    s = lock(s, L) // delete → ban-credit
    expect(isLocked(s, L)).toBe(true)
    // Forced kick even though the lemma is NOT in S_v:
    expect(classifyCommit(s, L, false)).toEqual({ kicks: true, trigger: 'locked' })
  })

  it('a locked lemma is suppressed from suggestion popovers', () => {
    let s = emptyScasState()
    const L = 'concept'
    expect(isSuppressedFromSuggestions(s, L)).toBe(false)
    s = lock(s, L)
    expect(isSuppressedFromSuggestions(s, L)).toBe(true)
  })

  it('discharge frees a locked lemma → returns to Dormant', () => {
    let s = emptyScasState()
    const L = 'concept'
    s = lock(s, L)
    s = discharge(s, L)
    expect(isLocked(s, L)).toBe(false)
    expect(classifyCommit(s, L, false)).toEqual({ kicks: false, trigger: null }) // dormant again
    expect(isSuppressedFromSuggestions(s, L)).toBe(false)
  })

  it('locked persists across a resample (rotation is not the re-arm for a deletion debt)', () => {
    let s = emptyScasState()
    const L = 'concept'
    s = lock(s, L)
    s = resample(s, 1)
    expect(isLocked(s, L)).toBe(true)
    expect(classifyCommit(s, L, false).trigger).toBe('locked')
  })

  it('lock clears any prior satisfied entry for the lemma', () => {
    let s = emptyScasState()
    const L = 'idea'
    s = markSatisfied(s, L)
    s = lock(s, L)
    expect(isImmune(s, L)).toBe(false)
    expect(isLocked(s, L)).toBe(true)
  })
})

describe('purity / no retroactive churn', () => {
  it('transitions never mutate their input state', () => {
    const s0 = emptyScasState()
    const snapshot: ScasState = JSON.parse(JSON.stringify(s0))
    markSatisfied(s0, 'a')
    lock(s0, 'b')
    discharge(s0, 'b')
    resample(s0, 5)
    expect(s0).toEqual(snapshot) // original untouched
  })

  it('classifyCommit depends only on (state, lemma, inSv) — a resample cannot change a past verdict', () => {
    // A committed in-S kick that was resolved stays resolved; rotating S only affects FUTURE
    // commits. Here: the verdict for a locked lemma is identical before and after a resample.
    let s = lock(emptyScasState(), 'x')
    const before = classifyCommit(s, 'x', false)
    s = resample(s, 7)
    const after = classifyCommit(s, 'x', false)
    expect(after).toEqual(before)
  })
})

describe('liveKicks (outstanding-kick colouring)', () => {
  it('recordKick marks an in-S kick as coloured; resolving clears it', () => {
    let s = emptyScasState()
    const L = 'idea'
    s = recordKick(s, L)
    expect(isColoured(buildLookup(s), L)).toBe(true)
    s = markSatisfied(s, L) // swap / dismiss
    expect(isColoured(buildLookup(s), L)).toBe(false)
  })

  it('a live kick survives a resample (rotation does not de-colour committed text)', () => {
    let s = recordKick(emptyScasState(), 'idea')
    s = resample(s, 1)
    expect(isColoured(buildLookup(s), 'idea')).toBe(true)
  })

  it('deleting a live kick moves the colour from liveKicks to locked', () => {
    let s = recordKick(emptyScasState(), 'idea')
    s = lock(s, 'idea')
    const lk = buildLookup(s)
    expect(lk.liveKicks.has('idea')).toBe(false)
    expect(lk.locked.has('idea')).toBe(true)
    expect(isColoured(lk, 'idea')).toBe(true) // still purple, now forced
  })

  it('recordKick is idempotent', () => {
    let s = recordKick(emptyScasState(), 'idea')
    s = recordKick(s, 'idea')
    expect(s.liveKicks).toEqual(['idea'])
  })
})

describe('buildLookup (renderer read model)', () => {
  it('reflects locked and current-version immune lemmas', () => {
    let s = emptyScasState()
    s = lock(s, 'banned')
    s = markSatisfied(s, 'safe')
    const lk = buildLookup(s)
    expect(lk.locked.has('banned')).toBe(true)
    expect(lk.immune.has('safe')).toBe(true)
    // After a resample the immune entry drops out of the lookup:
    const lk2 = buildLookup(resample(s, 1))
    expect(lk2.immune.has('safe')).toBe(false)
    expect(lk2.locked.has('banned')).toBe(true)
  })

  it('aMemberOf returns a real pool member (sanity for the in-S fixtures)', () => {
    expect(POOL_SET.has(aMemberOf(0))).toBe(true)
  })
})
