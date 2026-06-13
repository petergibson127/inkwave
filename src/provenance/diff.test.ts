import { describe, it, expect } from 'vitest'
import { diffWords, diffStats } from './diff'

describe('diffWords', () => {
  it('reports no changes for identical text', () => {
    const ops = diffWords('the calm sea', 'the calm sea')
    expect(ops.every((o) => o.type === 'same')).toBe(true)
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 })
  })

  it('detects an inserted word', () => {
    const ops = diffWords('the sea', 'the calm sea')
    expect(ops.some((o) => o.type === 'add' && /calm/.test(o.text))).toBe(true)
    expect(diffStats(ops).added).toBe(1)
    expect(diffStats(ops).removed).toBe(0)
  })

  it('detects a removed word', () => {
    const ops = diffWords('the calm sea', 'the sea')
    expect(ops.some((o) => o.type === 'del' && /calm/.test(o.text))).toBe(true)
    expect(diffStats(ops)).toEqual({ added: 0, removed: 1 })
  })

  it('round-trips: same+del reconstructs prev, same+add reconstructs next', () => {
    const prev = 'a quick brown fox jumped'
    const next = 'a slow brown cat jumped over'
    const ops = diffWords(prev, next)
    const rebuiltPrev = ops.filter((o) => o.type !== 'add').map((o) => o.text).join('')
    const rebuiltNext = ops.filter((o) => o.type !== 'del').map((o) => o.text).join('')
    expect(rebuiltPrev).toBe(prev)
    expect(rebuiltNext).toBe(next)
  })
})
