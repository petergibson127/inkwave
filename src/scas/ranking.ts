// Stochastic re-ranking for SCAS variant.
//
// Each paragraph gets a deterministically perturbed view of the word frequency
// list. The perturbation is seeded by (documentSeed + paragraphIndex), so it
// is stable across sessions but unpredictable to a copy-paster.

import { WORD_FREQUENCY_LIST } from '../data/wordFrequency'

// ---------------------------------------------------------------------------
// Mulberry32 — fast, seedable 32-bit PRNG (public domain)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Turn an arbitrary string into a uint32 seed via a simple hash.
function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Cache: paragraphKey -> Set<string> of active vocab
// ---------------------------------------------------------------------------
const rankCache = new Map<string, Set<string>>()

function cacheKey(paragraphIndex: number, sessionSeed: string, n: number | 'infinite'): string {
  return `${sessionSeed}:${paragraphIndex}:${n}`
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Returns the active vocabulary set for a given paragraph.
 * Words in this set are considered "in vocab" — they will NOT be highlighted.
 *
 * The ranking is deterministic per (sessionSeed, paragraphIndex) but varies
 * across documents because sessionSeed differs per document.
 *
 * @param paragraphIndex  0-based index of the paragraph in the document
 * @param sessionSeed     document.scasSessionSeed (a UUID set at document creation)
 * @param n               vocabulary cap — top-N words are active. 'infinite' = all words active.
 */
export function getActiveVocab(
  paragraphIndex: number,
  sessionSeed: string,
  n: number | 'infinite'
): Set<string> {
  if (n === 'infinite') {
    // Return a sentinel that always returns true — avoids building a 30k set.
    return FULL_VOCAB
  }

  const key = cacheKey(paragraphIndex, sessionSeed, n)
  if (rankCache.has(key)) return rankCache.get(key)!

  const seed = hashSeed(`${sessionSeed}:${paragraphIndex}`)
  const rand = mulberry32(seed)

  // Apply small perturbations to each word's base rank.
  // Perturbation magnitude: up to ±10% of N, so rare words occasionally
  // bubble into scope and common words occasionally slip out.
  const perturbRange = Math.max(1, Math.round(n * 0.1))

  const perturbed: Array<{ word: string; rank: number }> = WORD_FREQUENCY_LIST.map(
    (word, i) => ({
      word,
      rank: i + 1 + Math.floor(rand() * perturbRange * 2) - perturbRange,
    })
  )

  perturbed.sort((a, b) => a.rank - b.rank)

  const vocab = new Set(perturbed.slice(0, n).map((e) => e.word))
  rankCache.set(key, vocab)
  return vocab
}

/**
 * Returns true if the word is inside the active vocabulary for this paragraph.
 * Always true when n === 'infinite'.
 */
export function isInVocab(
  word: string,
  paragraphIndex: number,
  sessionSeed: string,
  n: number | 'infinite'
): boolean {
  if (n === 'infinite') return true
  return getActiveVocab(paragraphIndex, sessionSeed, n).has(word.toLowerCase())
}

/**
 * Clear the rank cache for a specific document (call when scasLimitN changes,
 * but only clear entries for paragraphs written AFTER the change — prior
 * paragraphs keep their original ranking).
 */
export function clearRankCacheFrom(sessionSeed: string, fromParagraph: number): void {
  for (const key of rankCache.keys()) {
    if (key.startsWith(sessionSeed + ':')) {
      const parts = key.split(':')
      const idx = parseInt(parts[1], 10)
      if (idx >= fromParagraph) rankCache.delete(key)
    }
  }
}

// Sentinel set that reports every word as present (used for 'infinite' mode).
// We proxy has() to always return true rather than building a 30k-entry set.
const FULL_VOCAB = new Proxy(new Set<string>(), {
  get(target, prop) {
    if (prop === 'has') return () => true
    if (prop === 'size') return Infinity
    return Reflect.get(target, prop)
  },
}) as Set<string>
