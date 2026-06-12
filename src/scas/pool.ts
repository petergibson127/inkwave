// The common pool `P` — the public boundary of the N-mode game (v4 spec §3/§4.1).
//
// P is the public top ~4,500 *content* lemmas. The real product builds it from the curated
// `inkwave-words-combined.csv` (with private selection weights — the moat); for M0 we derive
// a pragmatic stand-in from the in-repo Norvig/Google frequency list, minus a hand-list of
// function-ish words that should never be constrained. The pool is intentionally PUBLIC
// (Kerckhoffs: security lives only in the secret seed, never in hiding the word list), so this
// stand-in is fine to ship until the curated pool + weights land.
//
// P is an *ordered* array: the index is stable, which lets a set be represented as a bitmask
// over P later (M1 receipts). Membership is O(1) via POOL_SET.

import { WORD_FREQUENCY_LIST } from '../data/wordFrequency'

export const POOL_SIZE = 4500

// Function-ish words: articles, pronouns, prepositions, conjunctions, auxiliaries/modals,
// determiners, and a few discourse particles. These sit high in the frequency list but are
// not worth interrogating, so they never enter the game. Kept deliberately small and explicit.
const FUNCTION_WORDS = new Set<string>([
  // articles / determiners / quantifiers
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'either', 'neither',
  'all', 'any', 'some', 'no', 'none', 'both', 'few', 'many', 'much', 'most', 'more', 'less',
  'such', 'same', 'other', 'another', 'enough', 'several', 'own',
  // pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
  'who', 'whom', 'whose', 'which', 'what', 'whatever', 'whoever', 'whichever',
  'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
  'everyone', 'everybody', 'everything', 'nobody', 'nothing', 'one', 'ones',
  // prepositions
  'of', 'to', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up', 'down', 'out', 'off',
  'over', 'under', 'above', 'below', 'into', 'onto', 'upon', 'about', 'against', 'between',
  'among', 'through', 'during', 'before', 'after', 'around', 'across', 'behind', 'beyond',
  'within', 'without', 'along', 'toward', 'towards', 'near', 'per', 'via', 'than', 'as',
  // conjunctions / connectives
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'else', 'because', 'although',
  'though', 'while', 'whereas', 'unless', 'until', 'since', 'whether', 'whenever', 'wherever',
  // auxiliaries / modals / be-do-have
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'ought',
  // common adverbs / particles that aren't worth interrogating
  'not', 'no', 'yes', 'too', 'very', 'just', 'only', 'also', 'even', 'still', 'almost',
  'here', 'there', 'now', 'then', 'when', 'where', 'why', 'how', 'again', 'once', 'ever',
  'never', 'always', 'often', 'sometimes', 'usually', 'perhaps', 'maybe', 'indeed',
  // frequency-list web-corpus noise that isn't real content vocabulary
  'pm', 'am', 're', 'www', 'http', 'https', 'com', 'org', 'net',
])

function isContentCandidate(w: string): boolean {
  // Lowercase alphabetic, length ≥ 3 (drops "pm"/"re"/"us"-type tokens), not a function word.
  return /^[a-z]+$/.test(w) && w.length >= 3 && !FUNCTION_WORDS.has(w)
}

/** The ordered common pool P — the public set of constrainable lemmas. */
export const POOL: readonly string[] = (() => {
  const out: string[] = []
  for (const w of WORD_FREQUENCY_LIST) {
    if (out.length >= POOL_SIZE) break
    if (isContentCandidate(w)) out.push(w)
  }
  return out
})()

/** O(1) membership: is this lemma in the game at all (N-mode)? */
export const POOL_SET: ReadonlySet<string> = new Set(POOL)

/** lemma → stable index in P (for the bitmask representation used by M1 receipts). */
export const POOL_INDEX: ReadonlyMap<string, number> = new Map(POOL.map((w, i) => [w, i]))

// FNV-1a over the canonical pool, so a verifier can confirm it replayed against the same P.
// (M1 upgrades hashing to RFC 8785 JCS + SHA-256; this cheap hash is enough to id the pool.)
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Stable id + hash of P, recorded on the document for reproducibility. */
export const POOL_ID = `inkwave-pool-norvig-v1:${POOL.length}:${fnv1aHex(POOL.join(','))}`
