// Live-composition session orchestration (v4 spec §11, M3) — client side.
//
// A SessionRunner opens an anonymous session, holds the current server-issued exclusion set S_v
// (the writer composes against it), and once per signing period closes the period: it sends the
// period's hashes (content + resolved kicks) to the signing service, receives the signed receipt
// + the NEXT set, and chains the receipt into one fixed sequence. The server only ever sees hashes
// and forgets them; the writer keeps the whole chain.
//
// Wiring this runner into the editor's live loop (driving the SCAS controller off `current.lemmas`
// and calling closePeriod on the resample timer) is the remaining M3 integration step.

import type { KickEvent, SignedReceipt } from '../types/document'
import { kicksHash, genesisPrevHash, chainHash, bitmaskToLemmas } from './receipts'

interface IssuedSet {
  setVersion: number
  lockedSet: string // base64 bitmask over P
  lockedSetHash: string
}

export interface CurrentSet extends IssuedSet {
  lemmas: Set<string> // decoded off-limits lemmas for the controller's membership test
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null // offline — live composition degrades visibly (the writer self-declares the gap)
  }
}

export class SessionRunner {
  readonly sessionToken: string
  readonly receipts: SignedReceipt[] = []
  current: CurrentSet

  private readonly docId: string
  private counter = 0
  private prevHash: string // prevHash for the NEXT receipt

  private constructor(docId: string, sessionToken: string, prevHash: string, current: CurrentSet) {
    this.docId = docId
    this.sessionToken = sessionToken
    this.prevHash = prevHash
    this.current = current
  }

  /** Open a session and receive the initial set (version 0). Returns null if the service is down. */
  static async open(docId: string): Promise<SessionRunner | null> {
    const s = await postJson<{ sessionToken: string } & IssuedSet>('/api/session', { docId })
    if (!s) return null
    const prevHash = await genesisPrevHash(s.sessionToken)
    const current: CurrentSet = {
      setVersion: s.setVersion,
      lockedSet: s.lockedSet,
      lockedSetHash: s.lockedSetHash,
      lemmas: bitmaskToLemmas(s.lockedSet),
    }
    return new SessionRunner(docId, s.sessionToken, prevHash, current)
  }

  /**
   * Close the current period: sign its receipt over (contentHash, the set version active this
   * period, the kicks resolved this period) and advance to the next server-issued set. Returns the
   * new receipt, or null if the service is unreachable (the period stays open, retried next tick).
   */
  async closePeriod(contentHash: string, kicks: KickEvent[], cadenceDigest?: string): Promise<SignedReceipt | null> {
    const kh = await kicksHash(kicks)
    const resp = await postJson<{
      serverTime: string
      signature: string
      lockedSet: string
      lockedSetHash: string
      next: IssuedSet
    }>('/api/sign', {
      sessionToken: this.sessionToken,
      docId: this.docId,
      counter: this.counter,
      prevHash: this.prevHash,
      contentHash,
      setVersion: this.current.setVersion,
      kicksHash: kh,
      ...(cadenceDigest ? { cadenceDigest } : {}),
    })
    if (!resp) return null

    const receipt: SignedReceipt = {
      v: 1,
      sessionToken: this.sessionToken,
      counter: this.counter,
      prevHash: this.prevHash,
      contentHash,
      setVersion: this.current.setVersion,
      lockedSetHash: resp.lockedSetHash,
      kicks,
      serverTime: resp.serverTime,
      signature: resp.signature,
      lockedSet: resp.lockedSet,
      ...(cadenceDigest ? { cadenceDigest } : {}),
    }
    this.receipts.push(receipt)
    this.prevHash = await chainHash(receipt)
    this.counter += 1
    this.current = {
      setVersion: resp.next.setVersion,
      lockedSet: resp.next.lockedSet,
      lockedSetHash: resp.next.lockedSetHash,
      lemmas: bitmaskToLemmas(resp.next.lockedSet),
    }
    return receipt
  }
}
