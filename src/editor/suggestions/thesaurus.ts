// Thesaurus integration — synonym lookups via Datamuse API.
//
// Datamuse is a free, no-auth REST API that returns synonyms, related words,
// and rhymes. We use `ml` (means like) and `rel_syn` (synonyms) to generate
// a small candidate list.
//
// Results are cached in memory so repeated lookups are instant.
// Offline or API failure returns an empty list (no suggestions shown).

const CACHE = new Map<string, string[]>()
// Return up to this many candidates — caller filters further by vocab.
const MAX_CANDIDATES = 40

/**
 * Derive a Datamuse `sp` (spelled-like) wildcard pattern from a word's suffix
 * so that results match the same grammatical form.
 * e.g. "running" → "*ing", "requirements" → "*s", "quickly" → "*ly"
 * Returns null for base/uninflected forms.
 */
function getSpPattern(word: string): string | null {
  const w = word.toLowerCase()
  if (w.endsWith('ing') && w.length > 5) return '*ing'
  if (w.endsWith('tion') && w.length > 6) return '*tion'
  if (w.endsWith('ness') && w.length > 6) return '*ness'
  if (w.endsWith('ment') && w.length > 6) return '*ment'
  if (w.endsWith('ation') && w.length > 7) return '*ation'
  if (w.endsWith('ly') && w.length > 4) return '*ly'
  if (w.endsWith('est') && w.length > 5) return '*est'
  if (w.endsWith('ed') && w.length > 4) return '*ed'
  if (w.endsWith('er') && w.length > 4) return '*er'
  if (w.endsWith('ies') && w.length > 4) return '*ies'
  if (w.endsWith('es') && w.length > 4) return '*es'
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) return '*s'
  return null
}

/**
 * Look up synonyms for a word.
 * Returns up to MAX_CANDIDATES alternatives, sorted by Datamuse score.
 * Returns [] on failure or if no synonyms found.
 */
export async function getSynonyms(word: string): Promise<string[]> {
  const key = word.toLowerCase()

  if (CACHE.has(key)) return CACHE.get(key)!

  // Apply a spelled-like pattern to the ml query so results match the
  // grammatical form of the input word (plurals stay plural, -ing stays -ing etc.)
  const spPattern = getSpPattern(key)
  const spParam = spPattern ? `&sp=${encodeURIComponent(spPattern)}` : ''

  try {
    // ml with sp= enforces form matching; rel_syn provides base-form alternatives.
    const [mlRes, synRes] = await Promise.allSettled([
      fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(key)}&max=40${spParam}`),
      fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(key)}&max=20`),
    ])

    // ml results go first — they are form-matched via sp=.
    // rel_syn results are base-form synonyms and only fill in as fallback.
    // Merging into a single score-sorted pool lets base forms outscore inflected
    // ones, breaking grammatical agreement — so we keep the two buckets separate.
    const seen = new Set<string>([key])
    const accept = (word: string) => {
      const w = word.toLowerCase()
      if (seen.has(w) || !/^[a-z]+$/.test(word)) return false
      seen.add(w)
      return true
    }

    const mlWords: string[] = []
    const synWords: string[] = []

    if (mlRes.status === 'fulfilled' && mlRes.value.ok) {
      const data: Array<{ word: string; score: number }> = await mlRes.value.json()
      data.sort((a, b) => b.score - a.score)
      for (const c of data) if (accept(c.word)) mlWords.push(c.word)
    }
    if (synRes.status === 'fulfilled' && synRes.value.ok) {
      const data: Array<{ word: string; score: number }> = await synRes.value.json()
      data.sort((a, b) => b.score - a.score)
      for (const c of data) if (accept(c.word)) synWords.push(c.word)
    }

    // Form-matched ml words fill first; rel_syn words top up if ml falls short.
    const unique = [...mlWords, ...synWords].slice(0, MAX_CANDIDATES)

    CACHE.set(key, unique)
    return unique
  } catch {
    // Offline or network error — return empty, don't cache so we retry next time.
    return []
  }
}

/**
 * Pre-warm the cache for a list of words (every red word on the page) so a click never waits on a
 * network round-trip. PACED — a few at a time with a small gap — so a burst of lookups doesn't trip
 * Datamuse's rate limiter, which would leave some words uncached (the click-lag / mid-drag reset).
 * Fire-and-forget. Words already cached or already queued are skipped.
 */
const PREFETCH_BATCH = 4
const PREFETCH_GAP_MS = 80
const prefetchQueue: string[] = []
let prefetchDraining = false

export function prefetchSynonyms(words: string[]): void {
  for (const word of words) {
    const key = word.toLowerCase()
    if (!CACHE.has(key) && !prefetchQueue.includes(key)) prefetchQueue.push(key)
  }
  if (!prefetchDraining) void drainPrefetchQueue()
}

async function drainPrefetchQueue(): Promise<void> {
  prefetchDraining = true
  try {
    while (prefetchQueue.length > 0) {
      const batch = prefetchQueue.splice(0, PREFETCH_BATCH).filter(w => !CACHE.has(w))
      if (batch.length) await Promise.all(batch.map(w => getSynonyms(w).catch(() => {})))
      if (prefetchQueue.length > 0) await new Promise(r => setTimeout(r, PREFETCH_GAP_MS))
    }
  } finally {
    prefetchDraining = false
  }
}
