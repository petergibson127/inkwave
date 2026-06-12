import { describe, it, expect } from 'vitest'
import { canonicalize, sha256Hex, hashCanonical, contentHash, bundleHash } from './hash'

describe('canonicalize (RFC 8785 JCS subset)', () => {
  it('sorts object keys by code-unit order', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
    expect(canonicalize({ z: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"z":1}') // uppercase < lowercase
  })
  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: { c: 'x' } })).toBe('{"a":[1,2],"b":{"c":"x"}}')
  })
  it('preserves array order and recurses', () => {
    expect(canonicalize([{ b: 1, a: 2 }, 3, 'x'])).toBe('[{"a":2,"b":1},3,"x"]')
  })
  it('handles null, booleans, and nested sorting', () => {
    expect(canonicalize({ on: true, off: false, none: null })).toBe('{"none":null,"off":false,"on":true}')
  })
  it('omits undefined members (parity with JSON)', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
  })
  it('is stable regardless of insertion order', () => {
    expect(canonicalize({ x: 1, y: 2 })).toBe(canonicalize({ y: 2, x: 1 }))
  })
  it('escapes strings per JSON', () => {
    expect(canonicalize('a"b\n')).toBe('"a\\"b\\n"')
  })
})

describe('sha256Hex', () => {
  it('matches the known NIST vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
  it('hashes the empty string correctly', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

describe('hashCanonical / contentHash', () => {
  it('is insertion-order independent', async () => {
    expect(await hashCanonical({ a: 1, b: 2 })).toBe(await hashCanonical({ b: 2, a: 1 }))
  })
  it('changes when content changes', async () => {
    const a = await contentHash({ type: 'doc', content: [{ type: 'paragraph' }] })
    const b = await contentHash({ type: 'doc', content: [{ type: 'paragraph', attrs: { x: 1 } }] })
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('bundleHash', () => {
  it('binds the content hash (and is deterministic)', async () => {
    const c = await contentHash({ type: 'doc' })
    const h1 = await bundleHash(c, [])
    const h2 = await bundleHash(c, [])
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
  it('defaults receipts to [] (matches the explicit empty form)', async () => {
    const c = await contentHash({ type: 'doc' })
    expect(await bundleHash(c)).toBe(await bundleHash(c, []))
  })
  it('changes when content or receipts change', async () => {
    const c = await contentHash({ type: 'doc' })
    const base = await bundleHash(c, [])
    expect(await bundleHash(c + '0', [])).not.toBe(base)
    expect(await bundleHash(c, [{ counter: 0 }])).not.toBe(base)
  })
})
