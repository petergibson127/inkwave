// A small word-level diff (LCS) for showing what changed between two versions of the writing —
// e.g. a snapshot vs the current document. Pure + framework-free. Tokenises on whitespace runs
// (keeping the whitespace as part of each token) so re-joining the `text` fields reproduces the
// original exactly.

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string }

// Split into tokens of [word][trailing-whitespace] so spacing survives a round-trip.
function tokenize(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? []
}

/** Word-level diff: returns ops in reading order. `add` = present only in `next`, `del` = only in `prev`. */
export function diffWords(prev: string, next: string): DiffOp[] {
  const a = tokenize(prev)
  const b = tokenize(next)
  const n = a.length
  const m = b.length

  // LCS length table (rows over `a`, cols over `b`).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  // Walk the table to emit ops, coalescing runs of the same type.
  const ops: DiffOp[] = []
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1]
    if (last && last.type === type) last.text += text
    else ops.push({ type, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', a[i]); i++ }
    else { push('add', b[j]); j++ }
  }
  while (i < n) { push('del', a[i]); i++ }
  while (j < m) { push('add', b[j]); j++ }
  return ops
}

/** A compact tally for a summary line ("+N words / −M words"). */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  const words = (t: string) => (t.match(/\S+/g) ?? []).length
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'add') added += words(op.text)
    else if (op.type === 'del') removed += words(op.text)
  }
  return { added, removed }
}
