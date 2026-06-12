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
// Rank lookup — built once at load time so isInVocab can check a word's rank.
// Words above RARE_THRESHOLD are treated as in-vocab (names, technical terms,
// very uncommon words that shouldn't be flagged as replaceable).
// ---------------------------------------------------------------------------
const RARE_THRESHOLD = 20000

const RANK_MAP = new Map<string, number>(
  WORD_FREQUENCY_LIST.map((w, i) => [w, i])
)

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
/**
 * Generate candidate base forms for a word so inflections match their base
 * in the vocabulary. e.g. "working"→"work", "quickly"→"quick", "runs"→"run".
 */
export function getStems(word: string): string[] {
  const w = word.toLowerCase()
  const out = new Set<string>([w])
  const add = (s: string) => { if (s.length > 2) out.add(s) }

  // Remove doubled final consonant: "running" → "run", "bigger" → "big"
  const undbl = (s: string) =>
    s.length > 2 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : s

  // -ies → -y  (libraries → library)
  if (w.endsWith('ies') && w.length > 4) add(w.slice(0, -3) + 'y')

  // -ing  (working→work, running→run, making→make)
  if (w.endsWith('ing') && w.length > 5) {
    const b = w.slice(0, -3)
    add(b); add(undbl(b)); add(b + 'e')
  }

  // -ed  (worked→work, stopped→stop, loved→love)
  if (w.endsWith('ed') && w.length > 4) {
    const b = w.slice(0, -2)
    add(b); add(undbl(b)); add(b + 'e')
  }

  // -es  (watches→watch, makes→make)
  if (w.endsWith('es') && w.length > 4) {
    add(w.slice(0, -2)); add(w.slice(0, -1))
  }

  // -s  (runs→run) — skip -ss words like "glass"
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) add(w.slice(0, -1))

  // -ily → -y  (happily→happy)
  if (w.endsWith('ily') && w.length > 5) add(w.slice(0, -3) + 'y')

  // -ly  (quickly→quick)
  if (w.endsWith('ly') && w.length > 4) add(w.slice(0, -2))

  // -ier → -y, -iest → -y  (easier→easy, easiest→easy)
  if (w.endsWith('ier') && w.length > 5) add(w.slice(0, -3) + 'y')
  if (w.endsWith('iest') && w.length > 6) add(w.slice(0, -4) + 'y')

  // -er, -est comparative  (faster→fast, bigger→big)
  if (w.endsWith('er') && w.length > 4) { const b = w.slice(0, -2); add(b); add(undbl(b)) }
  if (w.endsWith('est') && w.length > 5) { const b = w.slice(0, -3); add(b); add(undbl(b)) }

  // -ness  (darkness→dark)
  if (w.endsWith('ness') && w.length > 6) add(w.slice(0, -4))

  // -ment  (movement→move)
  if (w.endsWith('ment') && w.length > 6) { add(w.slice(0, -4)); add(w.slice(0, -4) + 'e') }

  // -ation / -tion → base  (organisation→organise, creation→create, action→act)
  if (w.endsWith('ation') && w.length > 7) {
    const b = w.slice(0, -5)
    add(b); add(b + 'e'); add(b + 'ise'); add(b + 'ize')
  } else if (w.endsWith('tion') && w.length > 6) {
    add(w.slice(0, -4)); add(w.slice(0, -4) + 'e')
  }

  // -ise / -ize normalization (AU/UK ↔ US spelling)
  // standardised→standard, organise→organ is too aggressive — only strip to check
  // the cross-spelling variant so "standardised" matches "standardize" in the list
  if (w.endsWith('ised') && w.length > 5) add(w.slice(0, -4) + 'ize')
  if (w.endsWith('ized') && w.length > 5) add(w.slice(0, -4) + 'ise')
  if (w.endsWith('ising') && w.length > 6) add(w.slice(0, -5) + 'izing')
  if (w.endsWith('izing') && w.length > 6) add(w.slice(0, -5) + 'ising')
  if (w.endsWith('ise') && w.length > 4) add(w.slice(0, -3) + 'ize')
  if (w.endsWith('ize') && w.length > 4) add(w.slice(0, -3) + 'ise')

  // Agent nouns: -er with silent e  (writer→write, teacher→teach)
  if (w.endsWith('er') && w.length > 4) add(w.slice(0, -2) + 'e')

  return [...out]
}

export function isInVocab(
  word: string,
  paragraphIndex: number,
  sessionSeed: string,
  n: number | 'infinite'
): boolean {
  if (n === 'infinite') return true

  const stems = getStems(word)

  // In the active top-N vocab → pass
  const vocab = getActiveVocab(paragraphIndex, sessionSeed, n)
  if (stems.some(s => vocab.has(s))) return true

  // No stem has a known mid-frequency rank → treat as in-vocab.
  // This covers proper nouns, names, technical terms, and any word
  // too rare to be worth flagging as replaceable.
  const isFlaggable = stems.some(s => {
    const rank = RANK_MAP.get(s)
    return rank !== undefined && rank < RARE_THRESHOLD
  })

  return !isFlaggable
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
