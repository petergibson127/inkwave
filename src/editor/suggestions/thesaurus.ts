// Thesaurus integration — synonym lookups via Datamuse API.
//
// Datamuse is a free, no-auth REST API that returns synonyms, related words,
// and rhymes. We use `rel_syn` (synonyms) and `rel_trg` (triggered by / semantically
// related) to generate a small candidate list.
//
// Results are cached in memory so repeated lookups are instant.
// Offline or API failure returns an empty list (no suggestions shown).

const CACHE = new Map<string, string[]>()
// Return up to this many candidates — caller filters further by vocab.
const MAX_CANDIDATES = 40

/**
 * Look up synonyms for a word.
 * Returns up to MAX_SUGGESTIONS alternatives, sorted by Datamuse score.
 * Returns [] on failure or if no synonyms found.
 */
export async function getSynonyms(word: string): Promise<string[]> {
  const key = word.toLowerCase()

  if (CACHE.has(key)) return CACHE.get(key)!

  try {
    // Fetch synonyms and semantically-triggered words in parallel.
    const [mlRes, synRes] = await Promise.allSettled([
      fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(key)}&max=40`),
      fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(key)}&max=20`),
    ])

    const candidates: Array<{ word: string; score: number }> = []

    if (mlRes.status === 'fulfilled' && mlRes.value.ok) {
      const data = await mlRes.value.json()
      candidates.push(...data)
    }
    if (synRes.status === 'fulfilled' && synRes.value.ok) {
      const data = await synRes.value.json()
      candidates.push(...data)
    }

    // Deduplicate, filter out the original word, sort by score desc.
    const seen = new Set<string>([key])
    const unique = candidates
      .filter((c) => {
        if (seen.has(c.word.toLowerCase())) return false
        seen.add(c.word.toLowerCase())
        return /^[a-z]+$/.test(c.word) // alphabetic only
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES)
      .map((c) => c.word)

    CACHE.set(key, unique)
    return unique
  } catch {
    // Offline or network error — return empty, don't cache so we retry next time.
    return []
  }
}

/**
 * Pre-warm the cache for a list of words (called when red highlights are rendered).
 * Fire-and-forget — does not block the UI.
 */
export function prefetchSynonyms(words: string[]): void {
  for (const word of words) {
    if (!CACHE.has(word.toLowerCase())) {
      void getSynonyms(word)
    }
  }
}
